using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Text;
using FlightSim.SimBridge.Adapters;
using FlightSim.SimBridge.Contracts;
using FlightSim.SimBridge.Msfs;
using FlightSim.SimBridge.Msfs.Native;

namespace FlightSim.SimBridge.Tests;

/// <summary>Builds receive buffers byte-for-byte as laid out in SimConnect.h (little-endian DWORDs).</summary>
internal static class SimConnectBuffers
{
    private static byte[] Message(SimConnectRecvId id, int size, Action<byte[]> fill)
    {
        var b = new byte[size];
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(0), (uint)size);
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(4), 4); // dwVersion
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(8), (uint)id);
        fill(b);
        return b;
    }

    private static void U32(byte[] b, int at, uint v) => BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(at), v);
    private static void Str(byte[] b, int at, string s, int size)
    {
        var bytes = Encoding.UTF8.GetBytes(s);
        bytes.AsSpan(0, Math.Min(bytes.Length, size)).CopyTo(b.AsSpan(at));
    }

    public static byte[] Open(string app = "KittyHawk", uint major = 12, uint minor = 1, uint bmaj = 282174, uint bmin = 999) =>
        Message(SimConnectRecvId.Open, 12 + 256 + 4 * 10, b =>
        {
            Str(b, 12, app, 256);
            U32(b, 268, major); U32(b, 272, minor); U32(b, 276, bmaj); U32(b, 280, bmin);
        });

    public static byte[] Quit() => Message(SimConnectRecvId.Quit, 12, _ => { });

    public static byte[] Exception(uint code, uint sendId, uint index = 1) =>
        Message(SimConnectRecvId.Exception, 24, b => { U32(b, 12, code); U32(b, 16, sendId); U32(b, 20, index); });

    public static byte[] Event(uint eventId, uint data, uint group = 0xFFFFFFFF) =>
        Message(SimConnectRecvId.Event, 24, b => { U32(b, 12, group); U32(b, 16, eventId); U32(b, 20, data); });

    public static byte[] EventFilename(uint eventId, string file) =>
        Message(SimConnectRecvId.EventFilename, 24 + 260 + 4, b => { U32(b, 12, 0xFFFFFFFF); U32(b, 16, eventId); Str(b, 24, file, 260); });

    public static byte[] SystemState(uint requestId, uint integer) =>
        Message(SimConnectRecvId.SystemState, 24 + 260, b => { U32(b, 12, requestId); U32(b, 16, integer); });

    public static byte[] SimObjectData(uint requestId, byte[] data, uint defineId = 1) =>
        Message(SimConnectRecvId.SimObjectData, 40 + data.Length, b =>
        {
            U32(b, 12, requestId); U32(b, 16, 0); U32(b, 20, defineId); U32(b, 32, 1); U32(b, 36, 1);
            data.CopyTo(b.AsSpan(40));
        });

    /// <summary>A packed data block for <paramref name="vars"/> (strings 256 bytes, FLOAT64 8 bytes), skipping <paramref name="omit"/>.</summary>
    public static byte[] Block(IReadOnlyList<SimVarRequest> vars, IReadOnlyDictionary<string, object> values, ISet<string>? omit = null)
    {
        var ms = new MemoryStream();
        foreach (var v in vars)
        {
            if (omit?.Contains(v.Name) == true) continue;
            if (v.IsString)
            {
                var field = new byte[256];
                if (values.TryGetValue(v.Name, out var s)) Str(field, 0, (string)s, 256);
                ms.Write(field);
            }
            else
            {
                var field = new byte[8];
                BinaryPrimitives.WriteDoubleLittleEndian(field, values.TryGetValue(v.Name, out var d) ? Convert.ToDouble(d, System.Globalization.CultureInfo.InvariantCulture) : 0);
                ms.Write(field);
            }
        }
        return ms.ToArray();
    }

    public static readonly IReadOnlyDictionary<string, object> A320AtGate = new Dictionary<string, object>
    {
        ["TITLE"] = "Airbus A320neo Asobo", ["ATC MODEL"] = "ATCCOM.AC_MODEL_A20N.0.text", ["SIM ON GROUND"] = 1.0,
        ["PLANE LATITUDE"] = 47.4489, ["PLANE LONGITUDE"] = -122.3094, ["INDICATED ALTITUDE"] = 433.2, ["PRESSURE ALTITUDE"] = 420.0,
        ["RADIO HEIGHT"] = 4.1, ["AIRSPEED INDICATED"] = 0.0, ["GROUND VELOCITY"] = 0.02, ["VERTICAL SPEED"] = 0.0,
        ["PLANE HEADING DEGREES TRUE"] = 179.5, ["FUEL TOTAL QUANTITY WEIGHT"] = 11287.6, ["NUMBER OF ENGINES"] = 2.0,
        ["GENERAL ENG COMBUSTION:1"] = 1.0, ["GENERAL ENG COMBUSTION:2"] = 0.0, ["GENERAL ENG COMBUSTION:3"] = 0.0, ["GENERAL ENG COMBUSTION:4"] = 0.0,
        ["BRAKE PARKING POSITION"] = 1.0,
    };
}

/// <summary>Fake of the native SimConnect API: records calls and serves queued receive buffers.</summary>
internal sealed class FakeSimConnectApi : ISimConnectApi
{
    public readonly ConcurrentQueue<byte[]> Inbox = new();
    public readonly List<(uint Define, string Name, string? Units, SimConnectDataType Type, uint SendId)> Definitions = [];
    public readonly List<string> SystemEvents = [];
    public readonly List<string> SystemStates = [];
    public int OpenResult = HResult.SOk;
    public Exception? OpenThrows;
    public Func<string, int>? AddResult;
    public int Requests;
    public int RequestResult = HResult.SOk;
    public int Closed;
    public bool QueueOpenOnConnect = true;
    public Func<byte[]>? OnRequest; // reply produced per data request
    private uint _sendId = 100;
    private static readonly IntPtr Handle = new(0x5150);

    public int Open(out IntPtr handle, string name, IntPtr eventHandle)
    {
        if (OpenThrows is not null) throw OpenThrows;
        handle = OpenResult == HResult.SOk ? Handle : IntPtr.Zero;
        if (OpenResult == HResult.SOk && QueueOpenOnConnect) Inbox.Enqueue(SimConnectBuffers.Open());
        return OpenResult;
    }

    public int Close(IntPtr handle)
    {
        Closed++;
        return HResult.SOk;
    }

    public int AddToDataDefinition(IntPtr handle, uint defineId, string datumName, string? unitsName, SimConnectDataType type)
    {
        var hr = AddResult?.Invoke(datumName) ?? HResult.SOk;
        if (HResult.Succeeded(hr)) Definitions.Add((defineId, datumName, unitsName, type, ++_sendId));
        return hr;
    }

    public int GetLastSentPacketId(IntPtr handle, out uint sendId)
    {
        sendId = _sendId;
        return HResult.SOk;
    }

    public int RequestDataOnSimObjectOnce(IntPtr handle, uint requestId, uint defineId)
    {
        Requests++;
        if (HResult.Succeeded(RequestResult) && OnRequest is not null) Inbox.Enqueue(OnRequest());
        return RequestResult;
    }

    public int SubscribeToSystemEvent(IntPtr handle, uint eventId, string systemEventName)
    {
        SystemEvents.Add(systemEventName);
        return HResult.SOk;
    }

    public int RequestSystemState(IntPtr handle, uint requestId, string state)
    {
        SystemStates.Add(state);
        return HResult.SOk;
    }

    public byte[]? GetNextDispatch(IntPtr handle) => Inbox.TryDequeue(out var b) ? b : null;

    public uint SendIdOf(string name) => Definitions.Single(d => d.Name == name).SendId;
}

internal sealed class RecordingCallbacks : ISimConnectCallbacks
{
    public readonly List<SimConnectOpenInfo> Opens = [];
    public readonly List<RawMsfsSample> Samples = [];
    public readonly List<uint> Exceptions = [];
    public readonly List<SimulatorStateChange> States = [];
    public int Quits;
    public void OnOpen(SimConnectOpenInfo info) => Opens.Add(info);
    public void OnQuit() => Quits++;
    public void OnSample(RawMsfsSample sample) => Samples.Add(sample);
    public void OnException(uint exceptionCode) => Exceptions.Add(exceptionCode);
    public void OnSimulatorState(SimulatorStateChange change) => States.Add(change);
}

public class SimConnectMessageParserTests
{
    [Fact]
    public void Parses_open_with_application_name_and_version()
    {
        var m = Assert.IsType<SimConnectOpen>(SimConnectMessageParser.Parse(SimConnectBuffers.Open("SunRise", 12, 1, 282174, 999)));
        Assert.Equal(("SunRise", 12u, 1u, 282174u, 999u), (m.ApplicationName, m.VersionMajor, m.VersionMinor, m.BuildMajor, m.BuildMinor));
    }

    [Fact]
    public void Parses_exception_event_filename_system_state_and_quit()
    {
        Assert.Equal(new SimConnectException(7, 105, 1), SimConnectMessageParser.Parse(SimConnectBuffers.Exception(7, 105)));
        Assert.Equal(new SimConnectEvent(0xFFFFFFFF, 2, 1), SimConnectMessageParser.Parse(SimConnectBuffers.Event(2, 1)));
        Assert.Equal(new SimConnectEventFilename(3, 0, @"SimObjects\Airplanes\A320\aircraft.CFG"), SimConnectMessageParser.Parse(SimConnectBuffers.EventFilename(3, @"SimObjects\Airplanes\A320\aircraft.CFG")));
        var st = Assert.IsType<SimConnectSystemState>(SimConnectMessageParser.Parse(SimConnectBuffers.SystemState(2, 1)));
        Assert.Equal((2u, 1u), (st.RequestId, st.Integer));
        Assert.IsType<SimConnectQuit>(SimConnectMessageParser.Parse(SimConnectBuffers.Quit()));
    }

    [Fact]
    public void Sim_object_data_block_starts_at_offset_40()
    {
        var m = Assert.IsType<SimConnectSimObjectData>(SimConnectMessageParser.Parse(SimConnectBuffers.SimObjectData(1, [1, 2, 3, 4, 5, 6, 7, 8])));
        Assert.Equal((1u, 1u), (m.RequestId, m.DefineId));
        Assert.Equal(new byte[] { 1, 2, 3, 4, 5, 6, 7, 8 }, m.Data);
    }

    [Fact]
    public void Truncated_and_unknown_messages_are_safe()
    {
        Assert.IsType<SimConnectMalformed>(SimConnectMessageParser.Parse(new byte[5]));
        Assert.IsType<SimConnectMalformed>(SimConnectMessageParser.Parse(SimConnectBuffers.Exception(1, 1).AsSpan(0, 16)));
        Assert.IsType<SimConnectMalformed>(SimConnectMessageParser.Parse(SimConnectBuffers.SimObjectData(1, []).AsSpan(0, 30)));
        var unknown = SimConnectBuffers.Quit();
        BinaryPrimitives.WriteUInt32LittleEndian(unknown.AsSpan(8), 0x7777);
        Assert.Equal(new SimConnectUnknown(0x7777), SimConnectMessageParser.Parse(unknown));
    }

    [Fact]
    public void Declared_size_limits_what_is_read()
    {
        var b = SimConnectBuffers.SimObjectData(1, new byte[16]);
        var padded = b.Concat(new byte[64]).ToArray(); // extra bytes beyond dwSize must be ignored
        Assert.Equal(16, Assert.IsType<SimConnectSimObjectData>(SimConnectMessageParser.Parse(padded)).Data.Length);
    }

    [Fact]
    public void Strings_are_nul_terminated_utf8_and_tolerate_missing_terminator()
    {
        var full = new string('X', 300);
        Assert.Equal(new string('X', 256), Assert.IsType<SimConnectOpen>(SimConnectMessageParser.Parse(SimConnectBuffers.Open(full))).ApplicationName);
        Assert.Equal("Cessna 172 Skyhawk – G1000", Assert.IsType<SimConnectOpen>(SimConnectMessageParser.Parse(SimConnectBuffers.Open("Cessna 172 Skyhawk – G1000"))).ApplicationName);
    }
}

public class TelemetryLayoutTests
{
    private static readonly IReadOnlyList<SimVarRequest> Vars = new Msfs2024Profile().TelemetryVars;

    [Fact]
    public void Decodes_every_value_by_name()
    {
        var layout = new TelemetryLayout(Vars);
        Assert.Equal(512 + 17 * 8, layout.FullSize);
        Assert.Equal(LayoutDecodeResult.Ok, layout.TryDecode(SimConnectBuffers.Block(Vars, SimConnectBuffers.A320AtGate), 4, out var s));
        Assert.Equal("Airbus A320neo Asobo", s!.Title);
        Assert.Equal(47.4489, s.LatitudeDeg);
        Assert.Equal(11287.6, s.FuelTotalWeightLb);
        Assert.Equal(new[] { 1.0, 0, 0, 0 }, s.EngineCombustion);
        Assert.Equal(1.0, s.ParkingBrakePosition);
    }

    [Theory]
    [InlineData(true)]  // rejected datum removed from the block
    [InlineData(false)] // rejected datum left in place
    public void A_rejected_simvar_becomes_unavailable_without_shifting_the_others(bool removedFromBlock)
    {
        var layout = new TelemetryLayout(Vars);
        Assert.True(layout.Reject(Vars.ToList().FindIndex(v => v.Name == "RADIO HEIGHT")));
        var block = SimConnectBuffers.Block(Vars, SimConnectBuffers.A320AtGate, removedFromBlock ? new HashSet<string> { "RADIO HEIGHT" } : null);
        Assert.Equal(LayoutDecodeResult.Ok, layout.TryDecode(block, 4, out var s));
        Assert.True(double.IsNaN(s!.RadioHeightFt));
        Assert.Equal(0.0, s.IndicatedAirspeedKt);
        Assert.Equal(179.5, s.HeadingTrueDeg);
        Assert.Equal(1.0, s.ParkingBrakePosition);
    }

    [Fact]
    public void An_unexpected_block_size_is_dropped_not_misparsed()
    {
        var layout = new TelemetryLayout(Vars);
        var block = SimConnectBuffers.Block(Vars, SimConnectBuffers.A320AtGate);
        Assert.Equal(LayoutDecodeResult.SizeMismatch, layout.TryDecode(block.AsSpan(0, block.Length - 8), 4, out var s));
        Assert.Null(s);
        Assert.Equal(LayoutDecodeResult.SizeMismatch, layout.TryDecode([], 4, out _));
    }

    [Fact]
    public void Normalizer_turns_garbage_doubles_into_unavailable_readings()
    {
        var values = new Dictionary<string, object>(SimConnectBuffers.A320AtGate) { ["PLANE LATITUDE"] = double.NaN, ["INDICATED ALTITUDE"] = 1e12, ["NUMBER OF ENGINES"] = 2.5 };
        var layout = new TelemetryLayout(Vars);
        layout.TryDecode(SimConnectBuffers.Block(Vars, values), 4, out var raw);
        var t = MsfsTelemetryNormalizer.Normalize(raw!, new Msfs2024Profile(), DateTimeOffset.UnixEpoch);
        Assert.Equal(ReadingQuality.Unavailable, t.Readings.LatDeg.Quality);
        Assert.Equal(ReadingQuality.Unavailable, t.Readings.IndicatedAltitudeFt.Quality);
        Assert.Equal(ReadingQuality.Unavailable, t.Readings.EngineCount.Quality);
        Assert.Equal(ReadingQuality.Unavailable, t.Readings.EnginesRunningCount.Quality);
        Assert.Equal(5120.0, t.Readings.TotalFuelKg.Value);
    }
}

public class NativeSimConnectClientTests
{
    private static readonly Msfs2024Profile Profile = new();

    private static (NativeSimConnectClient Client, FakeSimConnectApi Api, RecordingCallbacks Cb) Connected()
    {
        var api = new FakeSimConnectApi();
        var cb = new RecordingCallbacks();
        var client = NativeSimConnectClient.Open(api, "Turnline", cb);
        client.RegisterTelemetry(Profile);
        return (client, api, cb);
    }

    [Fact]
    public void Registers_the_profile_simvars_in_order_with_units_and_types()
    {
        var (client, api, _) = Connected();
        using var _c = client;
        Assert.Equal(Profile.TelemetryVars.Select(v => v.Name), api.Definitions.Select(d => d.Name));
        Assert.All(api.Definitions, d => Assert.Equal(NativeSimConnectClient.DefineTelemetry, d.Define));
        Assert.Equal((null, SimConnectDataType.String256), (api.Definitions[0].Units, api.Definitions[0].Type));
        var gs = api.Definitions.Single(d => d.Name == "GROUND VELOCITY");
        Assert.Equal(("knots", SimConnectDataType.Float64), (gs.Units, gs.Type));
        Assert.Equal(["Sim", "Pause", "AircraftLoaded"], api.SystemEvents);
        Assert.Equal(["Sim"], api.SystemStates);
    }

    [Fact]
    public void Open_failure_means_simulator_not_running_and_is_retryable()
    {
        var api = new FakeSimConnectApi { OpenResult = HResult.EFail };
        var ex = Assert.Throws<SimulatorUnavailableException>(() => NativeSimConnectClient.Open(api, "Turnline", new RecordingCallbacks()));
        Assert.Equal(Reason.Codes.SimulatorNotRunning, ex.Code);
        Assert.True(ex.Retryable);
    }

    [Fact]
    public void Missing_simconnect_dll_is_sdk_unavailable_and_not_retryable()
    {
        var api = new FakeSimConnectApi { OpenThrows = new DllNotFoundException("SimConnect.dll") };
        var ex = Assert.Throws<SimulatorUnavailableException>(() => NativeSimConnectClient.Open(api, "Turnline", new RecordingCallbacks()));
        Assert.Equal(Reason.Codes.SdkUnavailable, ex.Code);
        Assert.False(ex.Retryable);
    }

    [Fact]
    public void Dispatches_open_samples_and_quit()
    {
        var (client, api, cb) = Connected();
        using var _c = client;
        api.Inbox.Enqueue(SimConnectBuffers.SimObjectData(NativeSimConnectClient.RequestTelemetry, SimConnectBuffers.Block(Profile.TelemetryVars, SimConnectBuffers.A320AtGate)));
        api.Inbox.Enqueue(SimConnectBuffers.SimObjectData(99, new byte[8])); // someone else's request: ignored
        api.Inbox.Enqueue(SimConnectBuffers.Quit());
        client.ReceiveMessages();
        Assert.Equal("12.1.282174.999", Assert.Single(cb.Opens).Version);
        Assert.Equal("Airbus A320neo Asobo", Assert.Single(cb.Samples).Title);
        Assert.Equal(1, cb.Quits);
    }

    [Fact]
    public void Exception_for_a_definition_packet_rejects_that_simvar_only()
    {
        var (client, api, cb) = Connected();
        using var _c = client;
        api.Inbox.Enqueue(SimConnectBuffers.Exception(7 /* NAME_UNRECOGNIZED */, api.SendIdOf("RADIO HEIGHT")));
        api.Inbox.Enqueue(SimConnectBuffers.Exception(3, 9999)); // unrelated packet: no rejection
        api.Inbox.Enqueue(SimConnectBuffers.SimObjectData(NativeSimConnectClient.RequestTelemetry,
            SimConnectBuffers.Block(Profile.TelemetryVars, SimConnectBuffers.A320AtGate, new HashSet<string> { "RADIO HEIGHT" })));
        client.ReceiveMessages();
        var rejected = Assert.Single(cb.States, s => s.Kind == SimulatorStateKind.DatumRejected);
        Assert.Contains("RADIO HEIGHT", rejected.Detail, StringComparison.Ordinal);
        Assert.Equal([7u, 3u], cb.Exceptions);
        var s = Assert.Single(cb.Samples);
        Assert.True(double.IsNaN(s.RadioHeightFt));
        Assert.Equal(179.5, s.HeadingTrueDeg);
    }

    [Fact]
    public void A_simvar_whose_definition_call_fails_is_rejected_up_front()
    {
        var api = new FakeSimConnectApi { AddResult = n => n == "VERTICAL SPEED" ? HResult.EFail : HResult.SOk };
        var cb = new RecordingCallbacks();
        using var client = NativeSimConnectClient.Open(api, "Turnline", cb);
        client.RegisterTelemetry(Profile);
        Assert.Contains(cb.States, s => s.Kind == SimulatorStateKind.DatumRejected && s.Detail!.StartsWith("VERTICAL SPEED", StringComparison.Ordinal));
        api.Inbox.Enqueue(SimConnectBuffers.SimObjectData(1, SimConnectBuffers.Block(Profile.TelemetryVars, SimConnectBuffers.A320AtGate, new HashSet<string> { "VERTICAL SPEED" })));
        client.ReceiveMessages();
        Assert.True(double.IsNaN(Assert.Single(cb.Samples).VerticalSpeedFpm));
    }

    [Fact]
    public void Wrong_size_data_is_dropped_and_reported_once()
    {
        var (client, api, cb) = Connected();
        using var _c = client;
        api.Inbox.Enqueue(SimConnectBuffers.SimObjectData(1, new byte[100]));
        api.Inbox.Enqueue(SimConnectBuffers.SimObjectData(1, new byte[100]));
        client.ReceiveMessages();
        Assert.Empty(cb.Samples);
        Assert.Single(cb.States, s => s.Kind == SimulatorStateKind.LayoutMismatch);
    }

    [Fact]
    public void Reports_flight_pause_and_aircraft_state_without_file_paths()
    {
        var (client, api, cb) = Connected();
        using var _c = client;
        api.Inbox.Enqueue(SimConnectBuffers.SystemState(NativeSimConnectClient.RequestSimState, 0));
        api.Inbox.Enqueue(SimConnectBuffers.Event(NativeSimConnectClient.EventSim, 1));
        api.Inbox.Enqueue(SimConnectBuffers.Event(NativeSimConnectClient.EventPause, 1));
        api.Inbox.Enqueue(SimConnectBuffers.EventFilename(NativeSimConnectClient.EventAircraftLoaded, @"C:\Users\pilot.name\AppData\Local\Packages\SimObjects\Airplanes\A320\aircraft.CFG"));
        client.ReceiveMessages();
        Assert.Equal(
            [(SimulatorStateKind.InFlight, (bool?)false), (SimulatorStateKind.InFlight, true), (SimulatorStateKind.Paused, true), (SimulatorStateKind.AircraftLoaded, null)],
            cb.States.Select(s => (s.Kind, s.Active)));
        Assert.Equal("aircraft.CFG", cb.States[^1].Detail);
        Assert.DoesNotContain(cb.States, s => s.Detail?.Contains("pilot.name", StringComparison.Ordinal) == true);
    }

    [Fact]
    public void Malformed_messages_are_ignored_and_the_pump_is_bounded()
    {
        var (client, api, cb) = Connected();
        using var _c = client;
        api.Inbox.Enqueue(new byte[3]);
        for (var i = 0; i < 300; i++) api.Inbox.Enqueue(SimConnectBuffers.Event(NativeSimConnectClient.EventPause, (uint)(i % 2)));
        client.ReceiveMessages();
        Assert.True(api.Inbox.Count > 0, "one pump call must not drain an unbounded queue");
        Assert.True(cb.States.Count <= 256);
    }

    [Fact]
    public void Request_failure_throws_and_dispose_closes_once()
    {
        var (client, api, _) = Connected();
        api.RequestResult = HResult.EFail;
        Assert.Throws<InvalidOperationException>(client.RequestSample);
        client.Dispose();
        client.Dispose();
        Assert.Equal(1, api.Closed);
        Assert.Throws<ObjectDisposedException>(client.RequestSample);
    }

    [Theory]
    [InlineData(@"C:\a\b\aircraft.cfg", "aircraft.cfg")]
    [InlineData("SimObjects/Airplanes/x.cfg", "x.cfg")]
    [InlineData("plain.cfg", "plain.cfg")]
    public void File_name_only(string path, string expected) => Assert.Equal(expected, NativeSimConnectClient.FileNameOnly(path));
}

public class NativeAdapterEndToEndTests
{
    [Fact]
    public async Task Adapter_over_native_client_streams_normalized_telemetry_and_withholds_it_outside_a_flight()
    {
        var api = new FakeSimConnectApi();
        var vars = new Msfs2024Profile().TelemetryVars;
        var block = SimConnectBuffers.Block(vars, SimConnectBuffers.A320AtGate);
        api.OnRequest = () => SimConnectBuffers.SimObjectData(NativeSimConnectClient.RequestTelemetry, block);
        var diagnostics = new ConcurrentQueue<MsfsDiagnostic>();
        await using var adapter = new MsfsSimConnectAdapter(new Msfs2024Profile(), new NativeSimConnectClientFactory(api), sampleInterval: TimeSpan.FromMilliseconds(20))
        {
            Diagnostics = diagnostics.Enqueue,
        };
        Assert.Equal(SimConnectSdkStatus.Unverified, adapter.Capabilities.SdkStatus);
        var connection = await adapter.ConnectAsync(CancellationToken.None);
        Assert.Equal("12.1.282174.999", connection.SimulatorVersion);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var samples = new List<TelemetrySample>();
        await foreach (var s in adapter.ReadSamplesAsync(cts.Token))
        {
            samples.Add(s);
            if (samples.Count == 3)
            {
                // MSFS returns to the main menu: values no longer describe a flight.
                api.Inbox.Enqueue(SimConnectBuffers.Event(NativeSimConnectClient.EventSim, 0));
                await Task.Delay(400, cts.Token);
                var before = samples.Count;
                Assert.Contains(diagnostics, d => d is { Kind: "raw_sample", Dropped: true });
                api.Inbox.Enqueue(SimConnectBuffers.Event(NativeSimConnectClient.EventSim, 1));
                Assert.Equal(before, samples.Count);
            }
            if (samples.Count == 6) break;
        }
        var first = samples[0];
        Assert.Equal("Airbus A320neo Asobo", first.Aircraft.Title.Value);
        Assert.True(first.Readings.OnGround.Value);
        Assert.Equal(5120.0, first.Readings.TotalFuelKg.Value); // 11287.6 lb
        Assert.Equal(1, first.Readings.EnginesRunningCount.Value);
        Assert.True(first.Readings.ParkingBrakeSet.Value);
        Assert.Null(first.Aircraft.IcaoType.Value); // ATC MODEL localisation key is not trusted as ICAO
    }
}
