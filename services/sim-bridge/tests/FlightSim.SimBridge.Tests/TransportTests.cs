using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using FlightSim.SimBridge.Adapters;
using FlightSim.SimBridge.Contracts;
using FlightSim.SimBridge.Session;
using FlightSim.SimBridge.Transport;

namespace FlightSim.SimBridge.Tests;

public sealed class TransportTests : IAsyncLifetime
{
    private readonly string _pipeName = "flightsim-test-" + Guid.NewGuid().ToString("N")[..10];
    private readonly string _token = BridgeToken.Generate();
    private readonly CancellationTokenSource _cts = new();
    private NamedPipeBridgeServer _server = null!;
    private Task _serverTask = null!;
    private Task _sessionTask = null!;
    private MockSimulatorAdapter _adapter = null!;

    public Task InitializeAsync()
    {
        _server = new NamedPipeBridgeServer(new PipeServerOptions
        {
            PipeName = _pipeName,
            HelloTimeout = TimeSpan.FromMilliseconds(500),
            MaxLineBytes = 4096,
            MaxMalformedMessages = 3,
        }, BridgeToken.Parse(_token));
        _adapter = new MockSimulatorAdapter(new MockAdapterOptions { SampleInterval = TimeSpan.FromMilliseconds(20) });
        var session = new BridgeSession(_adapter, _server, TestSamples.FastOptions);
        _server.Attach(session);
        _serverTask = _server.RunAsync(_cts.Token);
        _sessionTask = session.RunAsync(_cts.Token);
        return Task.CompletedTask;
    }

    public async Task DisposeAsync()
    {
        await _cts.CancelAsync();
        await Task.WhenAll(_serverTask, _sessionTask).WaitAsync(TimeSpan.FromSeconds(5));
        await _adapter.DisposeAsync();
        _cts.Dispose();
    }

    private async Task<(NamedPipeClientStream Pipe, StreamReader Reader)> ConnectAsync()
    {
        var pipe = new NamedPipeClientStream(".", _pipeName, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await pipe.ConnectAsync(5000);
        return (pipe, new StreamReader(pipe, Encoding.UTF8));
    }

    private static async Task SendAsync(Stream pipe, string line)
    {
        await pipe.WriteAsync(Encoding.UTF8.GetBytes(line + "\n"));
        await pipe.FlushAsync();
    }

    private static string Hello(string token) =>
        $$$"""{"protocol":"flightsim.bridge","protocol_version":1,"type":"hello","data":{"token":"{{{token}}}","client":"test"}}""";

    private static async Task<JsonElement> ReadAsync(StreamReader reader)
    {
        var line = await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
        Assert.NotNull(line);
        Schemas.AssertValidMessage(line);
        return JsonDocument.Parse(line).RootElement.Clone();
    }

    private static async Task AssertClosedAsync(StreamReader reader)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        try
        {
            while (DateTime.UtcNow < deadline)
            {
                if (await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5)) is null) return;
            }
        }
        catch (IOException)
        {
            return; // reset by the server also counts as closed
        }
        Assert.Fail("Server did not close the connection.");
    }

    /// <summary>
    /// Connect and authenticate, retrying while the server re-arms its listener after a previous
    /// client (on Unix the listener is recreated per client, so a fast reconnect can hit a reset).
    /// </summary>
    private async Task<(NamedPipeClientStream Pipe, StreamReader Reader)> ConnectAuthenticatedAsync()
    {
        for (var attempt = 0; ; attempt++)
        {
            var (pipe, reader) = await ConnectAsync();
            try
            {
                await SendAsync(pipe, Hello(_token));
                Assert.Equal("hello.ok", (await ReadAsync(reader)).GetProperty("type").GetString());
                return (pipe, reader);
            }
            catch (IOException) when (attempt < 20)
            {
                await pipe.DisposeAsync();
                await Task.Delay(50);
            }
        }
    }

    [Fact]
    public async Task Authenticated_client_receives_hello_state_health_and_frames()
    {
        var (pipe, reader) = await ConnectAsync();
        await using var _ = pipe;
        await SendAsync(pipe, Hello(_token));

        var helloOk = await ReadAsync(reader);
        Assert.Equal("hello.ok", helloOk.GetProperty("type").GetString());
        Assert.Equal("mock", helloOk.GetProperty("data").GetProperty("adapter").GetString());
        Assert.Equal("connection.state", (await ReadAsync(reader)).GetProperty("type").GetString());
        Assert.Equal("bridge.health", (await ReadAsync(reader)).GetProperty("type").GetString());

        var frames = 0;
        while (frames < 3)
        {
            if ((await ReadAsync(reader)).GetProperty("type").GetString() == "telemetry.frame") frames++;
        }

        await SendAsync(pipe, """{"protocol":"flightsim.bridge","protocol_version":1,"type":"health.request","data":{}}""");
        JsonElement msg;
        do { msg = await ReadAsync(reader); } while (msg.GetProperty("type").GetString() != "bridge.health");
        Assert.Equal("not_applicable", msg.GetProperty("data").GetProperty("simconnect_sdk").GetString());
        Assert.Equal(1, _server.AuthenticatedClients);
    }

    [Fact]
    public async Task Wrong_token_is_rejected_and_connection_closed()
    {
        var (pipe, reader) = await ConnectAsync();
        await using var _ = pipe;
        await SendAsync(pipe, Hello(BridgeToken.Generate()));
        var error = await ReadAsync(reader);
        Assert.Equal("error", error.GetProperty("type").GetString());
        Assert.Equal("unauthorized", error.GetProperty("data").GetProperty("code").GetString());
        await AssertClosedAsync(reader);
        Assert.Equal(1, _server.RejectedClients);
        Assert.Equal(0, _server.AuthenticatedClients);
    }

    [Fact]
    public async Task Command_before_hello_is_rejected()
    {
        var (pipe, reader) = await ConnectAsync();
        await using var _ = pipe;
        await SendAsync(pipe, """{"protocol":"flightsim.bridge","protocol_version":1,"type":"health.request","data":{}}""");
        Assert.Equal("unauthorized", (await ReadAsync(reader)).GetProperty("data").GetProperty("code").GetString());
        await AssertClosedAsync(reader);
    }

    [Fact]
    public async Task Silent_client_is_dropped_after_hello_timeout()
    {
        var (pipe, reader) = await ConnectAsync();
        await using var _ = pipe;
        Assert.Equal("unauthorized", (await ReadAsync(reader)).GetProperty("data").GetProperty("code").GetString());
        await AssertClosedAsync(reader);
    }

    [Fact]
    public async Task Malformed_messages_get_errors_then_disconnect_after_budget()
    {
        var (pipe, reader) = await ConnectAsync();
        await using var _ = pipe;
        await SendAsync(pipe, Hello(_token));
        await SendAsync(pipe, "{not json");
        await SendAsync(pipe, """{"protocol":"flightsim.bridge","protocol_version":9,"type":"health.request","data":{}}""");
        await SendAsync(pipe, """{"protocol":"flightsim.bridge","protocol_version":1,"type":"telemetry.frame","data":{}}""");

        var errors = new List<string>();
        while (errors.Count < 3)
        {
            var line = await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
            if (line is null) break;
            var msg = JsonDocument.Parse(line).RootElement;
            if (msg.GetProperty("type").GetString() == "error") errors.Add(msg.GetProperty("data").GetProperty("code").GetString()!);
        }
        Assert.Equal(["malformed_message", "malformed_message", "unsupported_message"], errors);
        await AssertClosedAsync(reader);
    }

    [Fact]
    public async Task Oversize_line_disconnects_client()
    {
        var (pipe, reader) = await ConnectAsync();
        await using var _ = pipe;
        await SendAsync(pipe, Hello(_token));
        try
        {
            await SendAsync(pipe, new string('x', 10_000));
        }
        catch (IOException)
        {
            // The server may reset the connection while we are still writing.
        }
        await AssertClosedAsync(reader);
    }

    [Fact]
    public async Task Server_accepts_a_new_client_after_previous_disconnects()
    {
        var (first, _) = await ConnectAuthenticatedAsync();
        await first.DisposeAsync();

        var (second, _) = await ConnectAuthenticatedAsync();
        await second.DisposeAsync();
        Assert.Equal(2, _server.AuthenticatedClients);
    }

    [Theory]
    [InlineData("")]
    [InlineData("short")]
    [InlineData("has spaces in it ......................................")]
    public void Token_parser_rejects_weak_or_malformed_tokens(string token) =>
        Assert.Throws<FormatException>(() => BridgeToken.Parse(token));

    [Fact]
    public void Token_comparison_is_exact()
    {
        var t = BridgeToken.Generate();
        var parsed = BridgeToken.Parse(t);
        Assert.True(parsed.Matches(t));
        Assert.False(parsed.Matches(t[..^1] + (t[^1] == 'A' ? 'B' : 'A')));
        Assert.False(parsed.Matches(null));
        Assert.Equal("<redacted>", parsed.ToString());
    }
}
