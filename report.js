function csvCell(value) {
    let text = String(value);
    // Prevent imported text from being interpreted as an Excel formula.
    if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
}


function productBoxText(summary) {
    if (!summary.complete) return summary.count ? 'At least ' + summary.count + ' (incomplete)' : 'Unknown';
    return String(summary.count);
}

function deliveryBoxText(summary, declared) {
    const base = 'Declared boxes ' + declared + ' · Unique recorded boxes ' + summary.count;
    if (!summary.complete) return base + ' · Incomplete box data — ' + summary.issues.join('; ');
    if (summary.difference === 0) return base + ' · Recorded count matches declared count';
    return base + ' · Recorded minus declared ' + (summary.difference > 0 ? '+' : '') + summary.difference;
}
