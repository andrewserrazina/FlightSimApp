#if FLIGHTSIM_SIMCONNECT_SDK
// ============================================================================================
// UNVERIFIED SDK INTEGRATION
// This file is compiled ONLY when the bridge is built with -p:SimConnectSdkDir=<MSFS SDK>.
// It targets the managed SimConnect API (Microsoft.FlightSimulator.SimConnect) as documented at
// https://docs.flightsimulator.com/msfs2024/retail/programming-apis/simconnect/simconnect-sdk/
// It has NOT been compiled against an installed SDK nor run against MSFS 2020/2024 in this
// repository. Treat every line as needing review and runtime verification on a Windows test PC.
// ============================================================================================
using System.Runtime.InteropServices;
using FlightSim.SimBridge.Adapters;
using FlightSim.SimBridge.Contracts;
using Microsoft.FlightSimulator.SimConnect;

namespace FlightSim.SimBridge.Msfs;

internal sealed class ManagedSimConnectClientFactory : ISimConnectClientFactory
{
    public SimConnectSdkStatus SdkStatus => SimConnectSdkStatus.Unverified;

    public ISimConnectClient Open(string applicationName, ISimConnectCallbacks callbacks)
    {
        var messageReady = new EventWaitHandle(false, EventResetMode.AutoReset);
        try
        {
            var simConnect = new SimConnect(applicationName, IntPtr.Zero, 0, messageReady, 0);
            return new ManagedSimConnectClient(simConnect, messageReady, callbacks);
        }
        catch (COMException ex)
        {
            messageReady.Dispose();
            throw new SimulatorUnavailableException(Reason.Codes.SimulatorNotRunning, "MSFS is not running or refused the SimConnect connection.", inner: ex);
        }
    }
}

internal sealed class ManagedSimConnectClient : ISimConnectClient
{
    private enum Definition { Telemetry = 1 }
    private enum Request { Telemetry = 1 }

    // Layout must match MsfsProfileBase.BuildVars() order exactly (strings first, then FLOAT64s).
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi, Pack = 1)]
    private struct TelemetryStruct
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Title;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string AtcModel;
        public double SimOnGround;
        public double Latitude;
        public double Longitude;
        public double IndicatedAltitude;
        public double PressureAltitude;
        public double RadioHeight;
        public double IndicatedAirspeed;
        public double GroundVelocity;
        public double VerticalSpeed;
        public double HeadingTrue;
        public double FuelTotalWeight;
        public double NumberOfEngines;
        public double Combustion1;
        public double Combustion2;
        public double Combustion3;
        public double Combustion4;
        public double ParkingBrake;
    }

    private readonly SimConnect _simConnect;
    private readonly EventWaitHandle _messageReady;
    private readonly ISimConnectCallbacks _callbacks;

    public ManagedSimConnectClient(SimConnect simConnect, EventWaitHandle messageReady, ISimConnectCallbacks callbacks)
    {
        _simConnect = simConnect;
        _messageReady = messageReady;
        _callbacks = callbacks;
        _simConnect.OnRecvOpen += (_, data) => _callbacks.OnOpen(new SimConnectOpenInfo(
            data.szApplicationName,
            $"{data.dwApplicationVersionMajor}.{data.dwApplicationVersionMinor}.{data.dwApplicationBuildMajor}.{data.dwApplicationBuildMinor}"));
        _simConnect.OnRecvQuit += (_, _) => _callbacks.OnQuit();
        _simConnect.OnRecvException += (_, data) => _callbacks.OnException(data.dwException);
        _simConnect.OnRecvSimobjectData += (_, data) =>
        {
            if (data.dwRequestID != (uint)Request.Telemetry || data.dwData.Length == 0) return;
            var s = (TelemetryStruct)data.dwData[0];
            _callbacks.OnSample(new RawMsfsSample(
                s.Title, s.AtcModel, s.SimOnGround, s.Latitude, s.Longitude, s.IndicatedAltitude, s.PressureAltitude,
                s.RadioHeight, s.IndicatedAirspeed, s.GroundVelocity, s.VerticalSpeed, s.HeadingTrue, s.FuelTotalWeight,
                s.NumberOfEngines, [s.Combustion1, s.Combustion2, s.Combustion3, s.Combustion4], s.ParkingBrake));
        };
    }

    public WaitHandle MessageReady => _messageReady;

    public void RegisterTelemetry(IMsfsCompatibilityProfile profile)
    {
        if (profile.MaxEngines != 4) throw new NotSupportedException("TelemetryStruct is laid out for exactly 4 engines.");
        foreach (var v in profile.TelemetryVars)
        {
            _simConnect.AddToDataDefinition(Definition.Telemetry, v.Name, v.IsString ? null : v.Unit,
                v.IsString ? SIMCONNECT_DATATYPE.STRING256 : SIMCONNECT_DATATYPE.FLOAT64, 0.0f, SimConnect.SIMCONNECT_UNUSED);
        }
        _simConnect.RegisterDataDefineStruct<TelemetryStruct>(Definition.Telemetry);
    }

    public void RequestSample() =>
        _simConnect.RequestDataOnSimObject(Request.Telemetry, Definition.Telemetry, SimConnect.SIMCONNECT_OBJECT_ID_USER,
            SIMCONNECT_PERIOD.ONCE, SIMCONNECT_DATA_REQUEST_FLAG.DEFAULT, 0, 0, 0);

    public void ReceiveMessages()
    {
        try
        {
            _simConnect.ReceiveMessage();
        }
        catch (COMException)
        {
            _callbacks.OnQuit();
        }
    }

    public void Dispose()
    {
        _simConnect.Dispose();
        _messageReady.Dispose();
    }
}
#endif
