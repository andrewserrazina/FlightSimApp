using System.Globalization;
using FlightSim.SimBridge.Msfs.Gsx;

namespace FlightSim.SimBridge.Host;

/// <summary>
/// <c>flightsim-sim-bridge --gsx-receipts [--gsx-list-files]</c>: prints what the GSX Receipts folder
/// contains (groups, counts, sizes, dates). Read-only; nothing is opened, copied, parsed or written.
/// </summary>
internal static class GsxReceiptsCommand
{
    public static int Run(BridgeOptions options, TextWriter output)
    {
        var root = options.GsxReceiptsRoot ?? GsxReceiptsInventory.DefaultRoot();
        var result = GsxReceiptsInventory.Scan(root, options.GsxListFiles);
        output.Write(Format(result, options.GsxListFiles));
        return result.Status is GsxReceiptsFolderStatus.Found or GsxReceiptsFolderStatus.NotFound ? 0 : 6;
    }

    internal static string Format(GsxReceiptsInventoryResult r, bool listFiles)
    {
        var w = new StringWriter(CultureInfo.InvariantCulture);
        w.WriteLine("GSX receipts discovery (read-only: no file was opened, copied or changed)");
        w.WriteLine($"Folder: {r.Root}");
        switch (r.Status)
        {
            case GsxReceiptsFolderStatus.NotFound:
                w.WriteLine("Status: NOT FOUND. GSX Pro 4.x may not be installed, may not have issued an invoice yet, or may use another folder.");
                return w.ToString();
            case GsxReceiptsFolderStatus.AccessDenied:
            case GsxReceiptsFolderStatus.Error:
                w.WriteLine($"Status: {(r.Status == GsxReceiptsFolderStatus.AccessDenied ? "ACCESS DENIED" : "ERROR")}: {r.Error}");
                return w.ToString();
        }
        w.WriteLine($"Status: FOUND, {r.Groups.Count} group folder(s)");
        foreach (var g in r.Groups)
        {
            var span = g.OldestUtc is null ? "no files" : $"{g.OldestUtc:yyyy-MM-dd HH:mm}Z .. {g.NewestUtc:yyyy-MM-dd HH:mm}Z";
            w.WriteLine($"  {g.Name,-14} {(g.Documented ? "documented" : "not in GSX notes"),-17} files={g.FileCount}{(g.Truncated ? "+" : "")} html={g.HtmlCount} bytes={g.Bytes} {span}{(g.Error is null ? "" : $" ERROR: {g.Error}")}");
            if (listFiles)
            {
                foreach (var f in g.Files) w.WriteLine($"      {f.RelativePath}  {f.Bytes} B  {f.LastWriteUtc:yyyy-MM-dd HH:mm:ss}Z");
            }
        }
        if (r.DocumentedGroupsMissing.Count > 0) w.WriteLine($"Documented groups not present: {string.Join(", ", r.DocumentedGroupsMissing)}");
        if (listFiles) w.WriteLine("File names can contain a tail number. Redact them before sharing this output.");
        return w.ToString();
    }
}
