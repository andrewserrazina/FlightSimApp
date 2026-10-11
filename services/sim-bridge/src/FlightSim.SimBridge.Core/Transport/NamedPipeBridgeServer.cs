using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using FlightSim.SimBridge.Contracts;
using FlightSim.SimBridge.Session;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace FlightSim.SimBridge.Transport;

public sealed record PipeServerOptions
{
    public required string PipeName { get; init; }
    public TimeSpan HelloTimeout { get; init; } = TimeSpan.FromSeconds(5);
    public int MaxLineBytes { get; init; } = 64 * 1024;
    /// <summary>Outbound queue per client. Oldest messages are dropped if the client stalls.</summary>
    public int OutboundQueueCapacity { get; init; } = 256;
    public int MaxMalformedMessages { get; init; } = 5;
}

/// <summary>
/// Local IPC endpoint for the desktop shell. Security properties:
/// <list type="bullet">
/// <item>OS named pipe (Windows) / Unix domain socket (dev on Linux/macOS) — no network listener at all.</item>
/// <item><see cref="PipeOptions.CurrentUserOnly"/>: the OS rejects clients running as another user.</item>
/// <item>One client at a time; the first line must be a <c>hello</c> carrying the per-session token,
/// compared in constant time, within <see cref="PipeServerOptions.HelloTimeout"/>.</item>
/// <item>Bounded line length, bounded outbound queue, malformed-message budget.</item>
/// </list>
/// There is no HTTP surface, so no browser origin can reach the bridge; CORS does not apply.
/// </summary>
public sealed class NamedPipeBridgeServer : IBridgeOutput
{
    private readonly PipeServerOptions _options;
    private readonly BridgeToken _token;
    private readonly ILogger _log;
    private readonly object _gate = new();
    private Channel<BridgeEnvelope>? _client;
    private BridgeSession? _session;

    public NamedPipeBridgeServer(PipeServerOptions options, BridgeToken token, ILogger<NamedPipeBridgeServer>? logger = null)
    {
        if (string.IsNullOrWhiteSpace(options.PipeName) || options.PipeName.IndexOfAny(['/', '\\', ':']) >= 0)
        {
            throw new ArgumentException("Pipe name must be a bare name.", nameof(options));
        }
        _options = options;
        _token = token;
        _log = logger ?? NullLogger<NamedPipeBridgeServer>.Instance;
    }

    public int AuthenticatedClients { get; private set; }
    public int RejectedClients { get; private set; }

    public void Attach(BridgeSession session) => _session = session;

    public void Publish(BridgeEnvelope message)
    {
        Channel<BridgeEnvelope>? client;
        lock (_gate) client = _client;
        client?.Writer.TryWrite(message);
    }

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var pipe = new NamedPipeServerStream(
                _options.PipeName,
                PipeDirection.InOut,
                maxNumberOfServerInstances: 1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            await using (pipe.ConfigureAwait(false))
            {
                try
                {
                    await pipe.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false);
                    await HandleClientAsync(pipe, cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    break;
                }
                catch (IOException ex)
                {
                    _log.LogInformation("Bridge client disconnected: {Message}", ex.Message);
                }
            }
        }
    }

    private async Task HandleClientAsync(NamedPipeServerStream pipe, CancellationToken cancellationToken)
    {
        var reader = new BoundedLineReader(pipe, _options.MaxLineBytes);
        using var writeLock = new SemaphoreSlim(1, 1);

        // 1. Authenticate.
        string? first;
        using (var helloCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
        {
            helloCts.CancelAfter(_options.HelloTimeout);
            try
            {
                first = await reader.ReadLineAsync(helloCts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                first = null;
            }
            catch (LineTooLongException)
            {
                first = null;
            }
        }
        if (!TryParseHello(first, out var hello) || !_token.Matches(hello!.Token))
        {
            RejectedClients++;
            _log.LogWarning("Rejected bridge client: missing or invalid hello/token");
            await TryWriteAsync(pipe, writeLock, Error(Reason.Codes.Unauthorized, "Authentication failed."), cancellationToken).ConfigureAwait(false);
            return;
        }

        AuthenticatedClients++;
        _log.LogInformation("Bridge client authenticated: {Client}", Sanitize(hello.Client));
        var channel = Channel.CreateBounded<BridgeEnvelope>(new BoundedChannelOptions(_options.OutboundQueueCapacity)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
        });

        using var clientCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        lock (_gate) _client = channel;
        try
        {
            var session = _session;
            if (session is not null)
            {
                await WriteAsync(pipe, writeLock, new BridgeEnvelope(MessageTypes.HelloOk, new HelloOkV1(BridgeSession.BridgeVersion, session.SessionId, session.Simulator)), clientCts.Token).ConfigureAwait(false);
                await WriteAsync(pipe, writeLock, new BridgeEnvelope(MessageTypes.ConnectionState, session.CurrentState), clientCts.Token).ConfigureAwait(false);
                await WriteAsync(pipe, writeLock, new BridgeEnvelope(MessageTypes.BridgeHealth, session.GetHealth()), clientCts.Token).ConfigureAwait(false);
            }

            var sendLoop = SendLoopAsync(pipe, writeLock, channel.Reader, clientCts.Token);
            var receiveLoop = ReceiveLoopAsync(reader, pipe, writeLock, clientCts.Token);
            await Task.WhenAny(sendLoop, receiveLoop).ConfigureAwait(false);
            await clientCts.CancelAsync().ConfigureAwait(false);
            try
            {
                await Task.WhenAll(sendLoop, receiveLoop).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is OperationCanceledException or IOException or ObjectDisposedException)
            {
                // Client went away.
            }
        }
        finally
        {
            lock (_gate)
            {
                if (_client == channel) _client = null;
            }
            channel.Writer.TryComplete();
        }
    }

    private async Task SendLoopAsync(Stream pipe, SemaphoreSlim writeLock, ChannelReader<BridgeEnvelope> reader, CancellationToken cancellationToken)
    {
        await foreach (var message in reader.ReadAllAsync(cancellationToken).ConfigureAwait(false))
        {
            await WriteAsync(pipe, writeLock, message, cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task ReceiveLoopAsync(BoundedLineReader reader, Stream pipe, SemaphoreSlim writeLock, CancellationToken cancellationToken)
    {
        var malformed = 0;
        while (!cancellationToken.IsCancellationRequested)
        {
            string? line;
            try
            {
                line = await reader.ReadLineAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (LineTooLongException)
            {
                _log.LogWarning("Closing bridge client: oversize message");
                await TryWriteAsync(pipe, writeLock, Error(Reason.Codes.MalformedMessage, "Message too large."), cancellationToken).ConfigureAwait(false);
                return;
            }
            if (line is null) return; // client closed

            var reply = HandleClientMessage(line);
            if (reply is null) continue;
            if (reply.Type == MessageTypes.Error && ++malformed >= _options.MaxMalformedMessages)
            {
                _log.LogWarning("Closing bridge client: too many malformed messages");
                await TryWriteAsync(pipe, writeLock, reply, cancellationToken).ConfigureAwait(false);
                return;
            }
            await WriteAsync(pipe, writeLock, reply, cancellationToken).ConfigureAwait(false);
        }
    }

    private BridgeEnvelope? HandleClientMessage(string line)
    {
        InboundEnvelope? envelope;
        try
        {
            envelope = JsonSerializer.Deserialize<InboundEnvelope>(line, BridgeJson.Options);
        }
        catch (JsonException)
        {
            return Error(Reason.Codes.MalformedMessage, "Malformed JSON.");
        }
        if (envelope is null || envelope.Protocol != BridgeEnvelope.ProtocolName || envelope.ProtocolVersion != BridgeEnvelope.CurrentProtocolVersion)
        {
            return Error(Reason.Codes.MalformedMessage, "Unsupported protocol or version.");
        }
        var emptyData = envelope.Data.ValueKind == JsonValueKind.Object && !envelope.Data.EnumerateObject().Any();
        switch (envelope.Type)
        {
            case MessageTypes.HealthRequest when emptyData:
                return _session is { } s ? new BridgeEnvelope(MessageTypes.BridgeHealth, s.GetHealth()) : null;
            case MessageTypes.AdapterReconnect when emptyData:
                _session?.RequestReconnect();
                return null;
            case MessageTypes.HealthRequest or MessageTypes.AdapterReconnect:
                return Error(Reason.Codes.MalformedMessage, "Command data must be an empty object.");
            default:
                return Error(Reason.Codes.UnsupportedMessage, "Unsupported message type.");
        }
    }

    private static bool TryParseHello(string? line, out HelloV1? hello)
    {
        hello = null;
        if (line is null) return false;
        try
        {
            var envelope = JsonSerializer.Deserialize<InboundEnvelope>(line, BridgeJson.Options);
            if (envelope is not { Protocol: BridgeEnvelope.ProtocolName, ProtocolVersion: BridgeEnvelope.CurrentProtocolVersion, Type: MessageTypes.Hello }
                || envelope.Data.ValueKind != JsonValueKind.Object)
            {
                return false;
            }
            hello = envelope.Data.Deserialize<HelloV1>(BridgeJson.Options);
            return hello is { Token: not null, Client: not null };
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static BridgeEnvelope Error(string code, string message) => new(MessageTypes.Error, new Reason(code, message));

    private static async Task WriteAsync(Stream pipe, SemaphoreSlim writeLock, BridgeEnvelope message, CancellationToken cancellationToken)
    {
        var bytes = Encoding.UTF8.GetBytes(BridgeJson.Serialize(message) + "\n");
        await writeLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await pipe.WriteAsync(bytes, cancellationToken).ConfigureAwait(false);
            await pipe.FlushAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            writeLock.Release();
        }
    }

    private static async Task TryWriteAsync(Stream pipe, SemaphoreSlim writeLock, BridgeEnvelope message, CancellationToken cancellationToken)
    {
        try
        {
            await WriteAsync(pipe, writeLock, message, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException or OperationCanceledException)
        {
            // Peer already gone.
        }
    }

    private static string Sanitize(string value)
    {
        var clean = new string(value.Where(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.').Take(64).ToArray());
        return clean.Length == 0 ? "<unnamed>" : clean;
    }
}
