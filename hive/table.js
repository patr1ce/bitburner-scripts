
export async function main(ns) {
    const columns = [
        {header: "Name", field: "name", align: "left"},
        {header: "Count", field: "count"}
    ];
    const rows = [
        {name: "A", count: 2},
        {name: "B", count: 10},
        {name: "C"}
    ];
    ns.tprint("\n" + drawTable(columns, rows));
}

/*
columns: {width, header, field, format}
rows: obj with each [field]
*/
export function drawTable(columns, rows) {
    let lines = [];
    lines.push(drawHR(columns, ['┏', '┳', '━', '┓']));

    lines.push('┃ ' + columns.map((c)=>c.header).join(' ┃ ') + ' ┃');

    lines.push(drawHR(columns, ['┡', '╇', '━', '┩']));

    for (const row of rows) {
        const values = columns.map((col)=>{
            let val = row[col.field];
            if (col.format == 'time') {
                val = formatTime(val, col.precision);
            }
            else if (col.format == 'fraction') {
                val = formatFraction(val);
            }
            return pad(`${val || ''}`, col.width, ' ', col.align || 'right')
        });
        lines.push('│ ' + values.join(' │ ') + ' │');
    }

    lines.push(drawHR(columns, ['└', '┴', '─', '┘']));

    return lines.join('\n');
}

function drawHR(columns, glyphs=['└', '┴', '─', '┘']) {
    let line = glyphs[0];
    const segments = [];
    for (const col of columns) {
        col.width ||= col.header.length;
        const segment = pad('', col.width+2, glyphs[2]);
        segments.push(segment);
    }
    line = glyphs[0] + segments.join(glyphs[1]) + glyphs[3];
    return line;
}

function pad(str, length, filler=' ', align='right') {
    if (align == 'right') {
        while (str.length < length) {
            str = filler + str;
        }
    }
    else if (align == 'left') {
        while (str.length < length) {
            str = str + filler;
        }
    }
    else {
        while (str.length < length) {
            str = str + filler;
            if (str.length < length) {
                str = filler + str;
            }
        }
    }
    return str;
}

function formatTime(timeMS, precision=0) {
    if (!timeMS) {
        return '';
    }
    const d = new Date(2000, 1, 1, 0, 0, timeMS/1000)
    let timeStr = d.toTimeString().slice(0,8);
    if (timeMS >= 60 * 60 * 1000) {
        timeStr = timeStr.slice(0,8);
    }
    else if (timeMS >= 10 * 60 * 1000) {
        timeStr = timeStr.slice(3,8);
    }
    else {
        timeStr = timeStr.slice(4,8);
    }
    if (precision > 0) {
        let msStr = (timeMS / 1000 - Math.floor(timeMS/1000)).toFixed(precision);
        timeStr += msStr.substring(1);
    }
    return timeStr;
}

function formatFraction(fraction) {
    const values = fraction.filter((val)=>!!val);
    return values.join(" / ");
}
