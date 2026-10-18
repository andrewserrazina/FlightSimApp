using System.Buffers.Binary;

namespace FlightSim.SimBridge.Msfs.Gsx;

/// <summary>
/// Decodes a SimConnect data block of FLOAT64 GSX values in registration order. A rejected datum may
/// be absent or present (undocumented), so both sizes are accepted; any other size is dropped, never
/// misparsed. Rejected values become NaN.
/// </summary>
public static class GsxBlock
{
    public static bool TryDecode(ReadOnlySpan<byte> data, int count, IReadOnlySet<int> rejected, double[] values)
    {
        ArgumentNullException.ThrowIfNull(rejected);
        ArgumentNullException.ThrowIfNull(values);
        var full = count * 8;
        var reduced = (count - rejected.Count) * 8;
        bool rejectedPresent;
        if (data.Length == reduced) rejectedPresent = false;
        else if (data.Length >= full) rejectedPresent = true;
        else return false;
        var offset = 0;
        for (var i = 0; i < count; i++)
        {
            var isRejected = rejected.Contains(i);
            if (isRejected && !rejectedPresent) continue;
            var x = BinaryPrimitives.ReadDoubleLittleEndian(data.Slice(offset, 8));
            offset += 8;
            values[i] = isRejected ? double.NaN : x;
        }
        return true;
    }
}
