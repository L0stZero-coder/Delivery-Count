const rangeElement = (id) => document.getElementById(id);
const rangeIso = (value) => value.toLocaleDateString('sv-SE');
const rangeDisplay = (value) => value ? value.split('-').reverse().join('/') : '';
let rangeStart = '';
let rangeEnd = '';
let rangeMonth = new Date();
let choosingEnd = false;

function updateDateRangeLabel() {
    rangeElement('range-toggle').textContent = '▦ ' + rangeDisplay(rangeElement('date-from').value)
        + ' – ' + rangeDisplay(rangeElement('date-to').value);
}
function closeRange() {
    rangeElement('range-panel').hidden = true;
    rangeElement('range-toggle').setAttribute('aria-expanded', 'false');
}
function drawRange() {
    const calendars = rangeElement('range-calendars');
    calendars.replaceChildren();
    for (let offset = 0; offset < 2; offset++) {
        const month = new Date(rangeMonth.getFullYear(), rangeMonth.getMonth() + offset, 1);
        const section = document.createElement('section');
        const title = document.createElement('h3');
        title.textContent = month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
        const grid = document.createElement('div');
        grid.className = 'calendar-grid';
        for (const day of ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']) {
            const label = document.createElement('span');
            label.textContent = day;
            grid.append(label);
        }
        const first = new Date(month);
        first.setDate(1 - (month.getDay() + 6) % 7);
        for (let index = 0; index < 42; index++) {
            const day = new Date(first);
            day.setDate(first.getDate() + index);
            const iso = rangeIso(day);
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = day.getDate();
            button.className = 'calendar-day';
            button.disabled = day.getMonth() !== month.getMonth();
            button.setAttribute('aria-label', day.toLocaleDateString('en-GB', { dateStyle: 'full' }));
            button.setAttribute('aria-pressed', String(iso === rangeStart || iso === rangeEnd));
            if (rangeStart && rangeEnd && iso >= rangeStart && iso <= rangeEnd) button.classList.add('in-range');
            if (iso === rangeStart || iso === rangeEnd) button.classList.add('range-edge');
            button.addEventListener('click', () => {
                if (!choosingEnd) {
                    rangeStart = iso;
                    rangeEnd = '';
                    choosingEnd = true;
                } else {
                    [rangeStart, rangeEnd] = [rangeStart, iso].sort();
                    choosingEnd = false;
                }
                drawRange();
            });
            grid.append(button);
        }
        section.append(title, grid);
        calendars.append(section);
    }
    rangeElement('range-preview').textContent = rangeDisplay(rangeStart) + ' – ' + rangeDisplay(rangeEnd);
    rangeElement('range-help').textContent = choosingEnd ? 'Select the end date.' : 'Select a start date, then an end date.';
    rangeElement('range-apply').disabled = !rangeStart || !rangeEnd;
}
rangeElement('range-toggle').addEventListener('click', () => {
    if (!rangeElement('range-panel').hidden) {
        closeRange();
        return;
    }
    rangeStart = rangeElement('date-from').value;
    rangeEnd = rangeElement('date-to').value;
    const anchor = new Date((rangeEnd || rangeIso(new Date())) + 'T12:00:00');
    rangeMonth = new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1);
    choosingEnd = false;
    rangeElement('range-panel').hidden = false;
    rangeElement('range-toggle').setAttribute('aria-expanded', 'true');
    drawRange();
});
for (const [id, shift] of [['range-prev', -1], ['range-next', 1]]) {
    rangeElement(id).addEventListener('click', () => {
        rangeMonth.setMonth(rangeMonth.getMonth() + shift);
        drawRange();
    });
}
for (const preset of ['Today', 'Yesterday', 'Last 7 days', 'This month', 'Last month', 'This year']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = preset;
    button.addEventListener('click', () => {
        const end = new Date();
        const start = new Date(end);
        if (preset === 'Yesterday') {
            start.setDate(start.getDate() - 1);
            end.setDate(end.getDate() - 1);
        }
        if (preset === 'Last 7 days') start.setDate(start.getDate() - 6);
        if (preset === 'This month') {
            start.setDate(1);
            end.setMonth(end.getMonth() + 1, 0);
        }
        if (preset === 'Last month') {
            start.setDate(1);
            start.setMonth(start.getMonth() - 1);
            end.setDate(0);
        }
        if (preset === 'This year') {
            start.setMonth(0, 1);
            end.setMonth(11, 31);
        }
        rangeStart = rangeIso(start);
        rangeEnd = rangeIso(end);
        rangeMonth = new Date(end.getFullYear(), end.getMonth() - 1, 1);
        choosingEnd = false;
        drawRange();
    });
    rangeElement('range-presets').append(button);
}
rangeElement('range-cancel').addEventListener('click', () => { closeRange(); rangeElement('range-toggle').focus(); });
rangeElement('range-apply').addEventListener('click', () => {
    rangeElement('date-from').value = rangeStart;
    rangeElement('date-to').value = rangeEnd;
    updateDateRangeLabel();
    closeRange();
    rangeElement('range-toggle').focus();
    document.dispatchEvent(new Event('arrival-range-change'));
});
document.addEventListener('click', (event) => {
    // Calendar rendering replaces the clicked button before this handler runs.
    // The original event path still identifies clicks inside the date picker.
    const path = event.composedPath();
    if (!path.includes(rangeElement('range-panel')) && !path.includes(rangeElement('range-toggle'))) {
        closeRange();
    }
});
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !rangeElement('range-panel').hidden) {
        closeRange();
        rangeElement('range-toggle').focus();
    }
});
