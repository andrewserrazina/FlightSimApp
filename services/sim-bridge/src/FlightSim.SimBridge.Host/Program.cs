using System.Text.Json;
using FlightSim.SimBridge.Adapters;
using FlightSim.SimBridge.Contracts;
using FlightSim.SimBridge.Host;
using FlightSim.SimBridge.Msfs;
using FlightSim.SimBridge.Session;
using FlightSim.SimBridge.Transport;
using Microsoft.Extensions.Logging;

BridgeOptions options;
try
{
    options = BridgeOptions.Parse(args);
}
catch (ArgumentException ex)
{
    await Console.Error.WriteLineAsync($"error: {ex.Message}\n\n{BridgeOptions.Usage}").ConfigureAwait(false);
    return 2;
}

// Logs go to stderr only; stdout is reserved for the single machine-readable ready line.
using var loggers = LoggerFactory.Create(b => b
    .AddConsole(o => o.LogToStandardErrorThreshold = LogLevel.Trace)
    .AddSimpleConsole(o => { o.SingleLine = true; o.TimestampFormat = "HH:mm:ss.fff "; o.UseUtcTimestamp = true; })
    .SetMinimumLevel(LogLevel.Information));
var log = loggers.CreateLogger("bridge");

BridgeToken token;
try
{
    var raw = options.DevTokenFromEnv
        ? Environment.GetEnvironmentVariable(BridgeOptions.DevTokenEnvVar)
        : await Console.In.ReadLineAsync().ConfigureAwait(false);
    token = BridgeToken.Parse(raw);
}
catch (FormatException ex)
{
    log.LogCritical("Invalid bridge token: {Message}", ex.Message);
    return 3;
}

// Not disposed: ProcessExit/CancelKeyPress handlers may fire after Main returns.
var shutdown = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; shutdown.Cancel(); };
AppDomain.CurrentDomain.ProcessExit += (_, _) => shutdown.Cancel();

if (!options.DevTokenFromEnv)
{
    // Parent-death detection: the desktop shell holds our stdin open for its lifetime.
    _ = Task.Run(async () =>
    {
        while (await Console.In.ReadLineAsync().ConfigureAwait(false) is not null)
        {
            // Ignore any further stdin input.
        }
        log.LogInformation("stdin closed; shutting down");
        await shutdown.CancelAsync().ConfigureAwait(false);
    });
}

await using ISimulatorAdapter adapter = options.Adapter == SimulatorId.Mock
    ? new MockSimulatorAdapter(new MockAdapterOptions { ReportFuel = !options.MockNoFuel, StartOffset = TimeSpan.FromSeconds(options.MockStartOffsetSeconds) })
    : MsfsSimConnectAdapter.For(options.Adapter, loggers: loggers);

var server = new NamedPipeBridgeServer(new PipeServerOptions { PipeName = options.PipeName }, token, loggers.CreateLogger<NamedPipeBridgeServer>());
var session = new BridgeSession(adapter, server, logger: loggers.CreateLogger<BridgeSession>());
server.Attach(session);

log.LogInformation("sim-bridge {Version} starting: adapter={Adapter} sdk={Sdk}", BridgeSession.BridgeVersion,
    BridgeJson.ToWireName(options.Adapter), adapter.Capabilities.SdkStatus);

var serverTask = server.RunAsync(shutdown.Token);
var sessionTask = session.RunAsync(shutdown.Token);

Console.Out.WriteLine(JsonSerializer.Serialize(new Dictionary<string, string>
{
    ["event"] = "ready",
    ["pipe_name"] = options.PipeName,
    ["adapter"] = BridgeJson.ToWireName(options.Adapter),
    ["bridge_version"] = BridgeSession.BridgeVersion,
}));
Console.Out.Flush();

await Task.WhenAny(serverTask, sessionTask).ConfigureAwait(false);
await shutdown.CancelAsync().ConfigureAwait(false);
try
{
    await Task.WhenAll(serverTask, sessionTask).ConfigureAwait(false);
}
catch (OperationCanceledException)
{
    // normal shutdown
}
log.LogInformation("sim-bridge stopped");
return 0;
