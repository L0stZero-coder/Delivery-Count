function csvCell(value) {
    let text = String(value);
    // Prevent imported text from being interpreted as an Excel formula.
    if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
}

