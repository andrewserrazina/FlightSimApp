using FlightSim.SimBridge.Contracts;

namespace FlightSim.SimBridge.Adapters;

/// <summary>
/// Optional capability of an adapter that can observe GSX Pro (S2-05). Observations are read-only and
/// travel as their own <c>gsx.state</c> message; they never touch telemetry frames or the recorder.
/// Raised on an adapter thread while the adapter is connected.
/// </summary>
public interface IGsxFeedSource
{
    event Action<GsxObservation>? GsxObserved;
}
