// --- DOM Helper Functions ---

// DRY function to create a table cell
function createCell(className, contentEditable, innerText = '') {
    let td = document.createElement('td');
    if (className) td.className = className;
    td.contentEditable = contentEditable ? "true" : "false";
    td.innerText = innerText;
    return td;
}

// DRY function to create a table header
function createHeader(text, rowSpan = 1, className = '') {
    let th = document.createElement('th');
    th.textContent = text;
    if (rowSpan > 1) th.rowSpan = rowSpan;
    if (className) th.className = className;
    return th;
}