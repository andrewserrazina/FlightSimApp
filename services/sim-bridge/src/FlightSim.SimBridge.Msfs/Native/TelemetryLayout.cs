using System.Buffers.Binary;

namespace FlightSim.SimBridge.Msfs.Native;

public enum LayoutDecodeResult
{
    Ok,
    /// <summary>The data block matched no plausible layout; the sample was dropped (never misparsed).</summary>
    SizeMismatch,
}

/// <summary>
/// Decodes a SIMOBJECT_DATA block for the profile's data definition. SimConnect packs a definition
/// tightly in registration order: STRING256 = 256 bytes, FLOAT64 = 8 bytes. A datum the simulator
/// rejected (SimConnect exception for its AddToDataDefinition packet) is reported as unavailable
/// (NaN / null) rather than shifting every following value. Because it is not documented whether a
/// rejected datum is dropped from the block or left in place, both layouts are accepted and chosen by
/// exact size; anything else is dropped.
/// </summary>
public sealed class TelemetryLayout
{
    public const int StringSize = 256;
    public const int Float64Size = 8;

    private readonly IReadOnlyList<SimVarRequest> _vars;
    private readonly HashSet<int> _rejected = [];

    public TelemetryLayout(IReadOnlyList<SimVarRequest> vars) => _vars = vars;

    public IReadOnlyList<SimVarRequest> Vars => _vars;
    public IReadOnlyCollection<int> Rejected => _rejected;

    /// <summary>Mark datum <paramref name="index"/> as rejected by the simulator. Returns false if already rejected / out of range.</summary>
    public bool Reject(int index) => index >= 0 && index < _vars.Count && _rejected.Add(index);

    public int FullSize => SizeOf(includeRejected: true);
    public int ReducedSize => SizeOf(includeRejected: false);

    private int SizeOf(bool includeRejected)
    {
        var size = 0;
        for (var i = 0; i < _vars.Count; i++)
        {
            if (!includeRejected && _rejected.Contains(i)) continue;
            size += _vars[i].IsString ? StringSize : Float64Size;
        }
        return size;
    }

    public LayoutDecodeResult TryDecode(ReadOnlySpan<byte> data, int maxEngines, out RawMsfsSample? sample)
    {
        sample = null;
        bool rejectedPresent;
        if (data.Length == ReducedSize) rejectedPresent = false;
        else if (data.Length == FullSize) rejectedPresent = true;
        // Tolerate trailing padding only when it is unambiguous.
        else if (data.Length > FullSize) rejectedPresent = true;
        else if (data.Length > ReducedSize && _rejected.Count > 0) rejectedPresent = false;
        else return LayoutDecodeResult.SizeMismatch;

        var numbers = new Dictionary<string, double>(StringComparer.Ordinal);
        var strings = new Dictionary<string, string?>(StringComparer.Ordinal);
        var offset = 0;
        for (var i = 0; i < _vars.Count; i++)
        {
            var v = _vars[i];
            var isRejected = _rejected.Contains(i);
            if (isRejected && !rejectedPresent) continue;
            var size = v.IsString ? StringSize : Float64Size;
            var field = data.Slice(offset, size);
            offset += size;
            if (isRejected) continue; // present in the block but meaningless
            if (v.IsString) strings[v.Name] = SimConnectMessageParser.Str(field, 0, StringSize);
            else numbers[v.Name] = BinaryPrimitives.ReadDoubleLittleEndian(field);
        }

        double N(string name) => numbers.TryGetValue(name, out var x) ? x : double.NaN;
        var engines = new double[maxEngines];
        for (var e = 0; e < maxEngines; e++) engines[e] = N($"GENERAL ENG COMBUSTION:{e + 1}");
        sample = new RawMsfsSample(
            strings.GetValueOrDefault("TITLE"),
            strings.GetValueOrDefault("ATC MODEL"),
            N("SIM ON GROUND"),
            N("PLANE LATITUDE"),
            N("PLANE LONGITUDE"),
            N("INDICATED ALTITUDE"),
            N("PRESSURE ALTITUDE"),
            N("RADIO HEIGHT"),
            N("AIRSPEED INDICATED"),
            N("GROUND VELOCITY"),
            N("VERTICAL SPEED"),
            N("PLANE HEADING DEGREES TRUE"),
            N("FUEL TOTAL QUANTITY WEIGHT"),
            N("NUMBER OF ENGINES"),
            engines,
            N("BRAKE PARKING POSITION"));
        return LayoutDecodeResult.Ok;
    }
}
