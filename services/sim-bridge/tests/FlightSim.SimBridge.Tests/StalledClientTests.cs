using System.IO.Pipes;
using System.Text;
using FlightSim.SimBridge.Adapters;
using FlightSim.SimBridge.Session;
using FlightSim.SimBridge.Transport;

namespace FlightSim.SimBridge.Tests;

/// <summary>
/// S1-06 regression: a client that authenticates and then never reads must be dropped once writes
/// time out — and the server must keep serving (a later client can connect and authenticate).
/// Note: on Linux the large socket buffers mean the stall is usually ended by an IOException path;
/// the write-timeout path itself is exercised by TransportTests on the Windows CI runner.
/// </summary>
public class StalledClientTests
{
    [Fact]
    public async Task A_client_that_stops_reading_is_dropped_and_the_server_keeps_serving()
    {
        var pipeName = "flightsim-stall-" + Guid.NewGuid().ToString("N")[..10];
        var token = BridgeToken.Generate();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        var server = new NamedPipeBridgeServer(new PipeServerOptions { PipeName = pipeName, WriteTimeout = TimeSpan.FromMilliseconds(300), CloseWriteTimeout = TimeSpan.FromMilliseconds(100) }, BridgeToken.Parse(token));
        // Large, fast frames fill the pipe/socket buffers quickly once the client stops reading.
        await using var adapter = new MockSimulatorAdapter(new MockAdapterOptions { SampleInterval = TimeSpan.FromMilliseconds(1) });
        var session = new BridgeSession(adapter, server, TestSamples.FastOptions);
        server.Attach(session);
        var serverTask = server.RunAsync(cts.Token);
        var sessionTask = session.RunAsync(cts.Token);

        var hello = Encoding.UTF8.GetBytes($$$"""{"protocol":"flightsim.bridge","protocol_version":1,"type":"hello","data":{"token":"{{{token}}}","client":"stalled"}}""" + "\n");
        await using (var stalled = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly))
        {
            await stalled.ConnectAsync(5000, cts.Token);
            await stalled.WriteAsync(hello, cts.Token);
            // Never read. Keep the handle open until the server has given up on us.
            var until = DateTime.UtcNow.AddSeconds(60);
            while (server.AuthenticatedClients < 1 && DateTime.UtcNow < until) await Task.Delay(20, cts.Token);

            // A second client succeeds once the stalled one has been dropped (one server instance).
            var authenticated = false;
            while (!authenticated && DateTime.UtcNow < until)
            {
                await using var fresh = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                try
                {
                    await fresh.ConnectAsync(1000, cts.Token);
                    await fresh.WriteAsync(hello, cts.Token);
                    using var reader = new StreamReader(fresh, Encoding.UTF8);
                    var line = await reader.ReadLineAsync(cts.Token).AsTask().WaitAsync(TimeSpan.FromSeconds(5), cts.Token);
                    authenticated = line?.Contains("\"hello.ok\"", StringComparison.Ordinal) == true;
                }
                catch (Exception ex) when (ex is TimeoutException or IOException)
                {
                    // still occupied by the stalled client
                }
            }
            Assert.True(authenticated, "server did not accept a new client after a stalled one");
        }
        Assert.False(serverTask.IsFaulted, serverTask.Exception?.ToString());
        Assert.True(server.AuthenticatedClients >= 2);
        await cts.CancelAsync();
        await Task.WhenAll(serverTask, sessionTask).WaitAsync(TimeSpan.FromSeconds(10));
    }
}
