using FlightSim.SimBridge.Contracts;

namespace FlightSim.SimBridge.Session;

/// <summary>Where a session publishes outbound messages (the transport hub, or a test collector).</summary>
public interface IBridgeOutput
{
    void Publish(BridgeEnvelope message);
}
