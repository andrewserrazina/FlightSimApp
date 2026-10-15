using System.Diagnostics;
using FlightSim.SimBridge.Contracts;
using FlightSim.SimBridge.Transport;

namespace FlightSim.SimBridge.Tests;

/// <summary>
/// Regression for the Windows deadlock (S1-06): a peer that stops reading fills the small Windows pipe
/// buffer, so a write never completes. Writes must give up at their deadline instead of blocking the
/// close path forever. A stream that never completes a write reproduces this on every OS.
/// </summary>
public class WriteDeadlineTests
{
    private sealed class StalledStream : Stream
    {
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => 0;
        public override long Position { get; set; }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        // Like a full pipe: completes only when cancelled.
        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default) =>
            await Task.Delay(Timeout.Infinite, cancellationToken);
    }

    private static BridgeEnvelope Msg() => new(MessageTypes.Error, new Reason(Reason.Codes.MalformedMessage, "x"));

    [Fact]
    public async Task A_write_to_a_peer_that_never_drains_gives_up_at_its_deadline()
    {
        using var writeLock = new SemaphoreSlim(1, 1);
        var sw = Stopwatch.StartNew();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            NamedPipeBridgeServer.WriteWithDeadlineAsync(new StalledStream(), writeLock, Msg(), TimeSpan.FromMilliseconds(200), CancellationToken.None));
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(5));
        Assert.Equal(1, writeLock.CurrentCount); // lock released for the close path
    }

    [Fact]
    public async Task Waiting_for_the_write_lock_held_by_a_stuck_writer_also_times_out()
    {
        using var writeLock = new SemaphoreSlim(1, 1);
        var stuck = NamedPipeBridgeServer.WriteWithDeadlineAsync(new StalledStream(), writeLock, Msg(), TimeSpan.FromSeconds(30), CancellationToken.None);
        await Task.Delay(50);
        var sw = Stopwatch.StartNew();
        // The farewell error write must not wait behind the stuck telemetry write (the original deadlock).
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            NamedPipeBridgeServer.WriteWithDeadlineAsync(new MemoryStream(), writeLock, Msg(), TimeSpan.FromMilliseconds(200), CancellationToken.None));
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(5));
        _ = stuck.ContinueWith(_ => { }, TaskScheduler.Default);
    }
}
