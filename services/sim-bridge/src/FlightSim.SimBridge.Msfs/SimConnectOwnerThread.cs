using System.Collections.Concurrent;

namespace FlightSim.SimBridge.Msfs;

/// <summary>
/// The single thread that is allowed to touch SimConnect. Every SimConnect call (open, data
/// definitions, requests, message dispatch, close) is marshalled here and executed strictly one
/// at a time, in submission order. Nothing in this assembly calls the SDK from any other thread.
/// </summary>
/// <remarks>
/// The loop waits on two signals: queued work, and the SimConnect message-ready wait handle that
/// the client exposes. When the latter fires the loop calls <see cref="ISimConnectClient.ReceiveMessages"/>,
/// so SDK callbacks are also raised on this thread.
/// </remarks>
public sealed class SimConnectOwnerThread : IDisposable
{
    private readonly BlockingCollection<Action> _work = new(new ConcurrentQueue<Action>());
    private readonly AutoResetEvent _workReady = new(false);
    private readonly Thread _thread;
    private volatile WaitHandle? _messageReady;
    private volatile Action? _onMessageReady;
    private volatile bool _stopping;

    public SimConnectOwnerThread(string name = "SimConnect owner")
    {
        _thread = new Thread(Run) { IsBackground = true, Name = name };
        _thread.Start();
    }

    public int ManagedThreadId => _thread.ManagedThreadId;

    public bool IsOwnerThread => Environment.CurrentManagedThreadId == _thread.ManagedThreadId;

    /// <summary>Run <paramref name="func"/> on the owner thread and await its result.</summary>
    public Task<T> InvokeAsync<T>(Func<T> func)
    {
        ObjectDisposedException.ThrowIf(_stopping, this);
        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        Enqueue(() =>
        {
            try
            {
                tcs.SetResult(func());
            }
#pragma warning disable CA1031 // Marshalled back to the awaiting caller.
            catch (Exception ex)
#pragma warning restore CA1031
            {
                tcs.SetException(ex);
            }
        });
        return tcs.Task;
    }

    public Task InvokeAsync(Action action) => InvokeAsync(() =>
    {
        action();
        return true;
    });

    /// <summary>
    /// Register the SimConnect message-ready handle and the dispatch callback. Must be called on the
    /// owner thread (i.e. from inside an <see cref="InvokeAsync{T}"/> delegate).
    /// </summary>
    public void SetMessagePump(WaitHandle? messageReady, Action? onMessageReady)
    {
        if (!IsOwnerThread) throw new InvalidOperationException("SetMessagePump must be called on the SimConnect owner thread.");
        _messageReady = messageReady;
        _onMessageReady = onMessageReady;
    }

    private void Enqueue(Action action)
    {
        _work.Add(action);
        _workReady.Set();
    }

    private void Run()
    {
        while (!_stopping || _work.Count > 0)
        {
            while (_work.TryTake(out var item)) item();
            if (_stopping) break;

            var messageReady = _messageReady;
            var handles = messageReady is null ? new WaitHandle[] { _workReady } : [_workReady, messageReady];
            var signalled = WaitHandle.WaitAny(handles, TimeSpan.FromMilliseconds(250));
            if (signalled == 1)
            {
                _onMessageReady?.Invoke();
            }
        }
    }

    public void Dispose()
    {
        if (_stopping) return;
        _stopping = true;
        _workReady.Set();
        if (!IsOwnerThread) _thread.Join(TimeSpan.FromSeconds(5));
        _work.Dispose();
        _workReady.Dispose();
    }
}
