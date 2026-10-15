using System.Buffers.Binary;
using System.Text;

namespace FlightSim.SimBridge.Msfs.Native;

/// <summary>
/// SimConnect receive-message IDs (<c>SIMCONNECT_RECV_ID</c> in SimConnect.h). Only the ones this
/// bridge consumes are listed; anything else is parsed as <see cref="SimConnectUnknown"/> and ignored.
/// </summary>
public enum SimConnectRecvId : uint
{
    Null = 0,
    Exception = 1,
    Open = 2,
    Quit = 3,
    Event = 4,
    EventFilename = 6,
    SimObjectData = 8,
    SystemState = 15,
}

public abstract record SimConnectMessage;
public sealed record SimConnectOpen(string ApplicationName, uint VersionMajor, uint VersionMinor, uint BuildMajor, uint BuildMinor) : SimConnectMessage;
public sealed record SimConnectQuit : SimConnectMessage;
public sealed record SimConnectException(uint Code, uint SendId, uint Index) : SimConnectMessage;
public sealed record SimConnectEvent(uint GroupId, uint EventId, uint Data) : SimConnectMessage;
public sealed record SimConnectEventFilename(uint EventId, uint Data, string FileName) : SimConnectMessage;
public sealed record SimConnectSimObjectData(uint RequestId, uint ObjectId, uint DefineId, byte[] Data) : SimConnectMessage;
public sealed record SimConnectSystemState(uint RequestId, uint Integer, float Float, string Text) : SimConnectMessage;
public sealed record SimConnectUnknown(uint Id) : SimConnectMessage;
/// <summary>A message that was shorter than its declared type requires. Never dereferenced further.</summary>
public sealed record SimConnectMalformed(uint Id, int Length) : SimConnectMessage;

/// <summary>
/// Pure parser for SimConnect receive buffers. Layouts follow SimConnect.h (all fields are
/// little-endian DWORDs / fixed char arrays; the header is <c>dwSize, dwVersion, dwID</c>):
/// <list type="bullet">
/// <item>OPEN: szApplicationName[256] @12, then app version major/minor, build major/minor.</item>
/// <item>EXCEPTION: dwException @12, dwSendID @16, dwIndex @20.</item>
/// <item>EVENT: uGroupID @12, uEventID @16, dwData @20.</item>
/// <item>EVENT_FILENAME: EVENT fields, then szFileName[MAX_PATH=260] @24.</item>
/// <item>SIMOBJECT_DATA: dwRequestID @12, dwObjectID @16, dwDefineID @20, dwFlags, dwentrynumber,
///   dwoutof, dwDefineCount, then the packed data block @40.</item>
/// <item>SYSTEM_STATE: dwRequestID @12, dwInteger @16, fFloat @20, szString[260] @24.</item>
/// </list>
/// Every read is bounds-checked; a short buffer yields <see cref="SimConnectMalformed"/>.
/// </summary>
public static class SimConnectMessageParser
{
    public const int HeaderSize = 12;
    public const int SimObjectDataOffset = 40;
    public const int MaxPath = 260;

    public static SimConnectMessage Parse(ReadOnlySpan<byte> buffer)
    {
        if (buffer.Length < HeaderSize) return new SimConnectMalformed(uint.MaxValue, buffer.Length);
        var declared = U32(buffer, 0);
        // Trust the smaller of the declared size and the bytes actually provided.
        if (declared >= HeaderSize && declared < buffer.Length) buffer = buffer[..(int)declared];
        var id = U32(buffer, 8);
        try
        {
            return (SimConnectRecvId)id switch
            {
                SimConnectRecvId.Open => new SimConnectOpen(Str(buffer, 12, 256), U32(buffer, 268), U32(buffer, 272), U32(buffer, 276), U32(buffer, 280)),
                SimConnectRecvId.Quit => new SimConnectQuit(),
                SimConnectRecvId.Exception => new SimConnectException(U32(buffer, 12), U32(buffer, 16), U32(buffer, 20)),
                SimConnectRecvId.Event => new SimConnectEvent(U32(buffer, 12), U32(buffer, 16), U32(buffer, 20)),
                SimConnectRecvId.EventFilename => new SimConnectEventFilename(U32(buffer, 16), U32(buffer, 20), Str(buffer, 24, MaxPath)),
                SimConnectRecvId.SimObjectData => buffer.Length < SimObjectDataOffset
                    ? new SimConnectMalformed(id, buffer.Length)
                    : new SimConnectSimObjectData(U32(buffer, 12), U32(buffer, 16), U32(buffer, 20), buffer[SimObjectDataOffset..].ToArray()),
                SimConnectRecvId.SystemState => new SimConnectSystemState(U32(buffer, 12), U32(buffer, 16), BinaryPrimitives.ReadSingleLittleEndian(Slice(buffer, 20, 4)), Str(buffer, 24, MaxPath)),
                _ => new SimConnectUnknown(id),
            };
        }
        catch (ArgumentOutOfRangeException)
        {
            return new SimConnectMalformed(id, buffer.Length);
        }
    }

    internal static uint U32(ReadOnlySpan<byte> b, int offset) => BinaryPrimitives.ReadUInt32LittleEndian(Slice(b, offset, 4));

    private static ReadOnlySpan<byte> Slice(ReadOnlySpan<byte> b, int offset, int length)
    {
        if (offset < 0 || offset + length > b.Length) throw new ArgumentOutOfRangeException(nameof(offset));
        return b.Slice(offset, length);
    }

    /// <summary>Fixed-size, NUL-terminated char array. Decoded as UTF-8 (invalid bytes replaced).</summary>
    internal static string Str(ReadOnlySpan<byte> b, int offset, int size)
    {
        // A truncated trailing string field is tolerated (only the bytes present are used).
        if (offset > b.Length) throw new ArgumentOutOfRangeException(nameof(offset));
        var field = b.Slice(offset, Math.Min(size, b.Length - offset));
        var nul = field.IndexOf((byte)0);
        return Encoding.UTF8.GetString(nul >= 0 ? field[..nul] : field);
    }
}
