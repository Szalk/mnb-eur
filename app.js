// Konfigurációs objektum
const CONFIG = {
    headerRow: 5,
    currencyFilter: 'EUR',
    
    columns: {
        invoiceNum: 'Számla száma',
        issueDate: 'Számla kelte',           // Kiállítás dátuma
        performanceDate: 'Teljesítés dátuma', // Teljesítés dátuma (új)
        currency: 'Számla pénzneme',
        eurAmount: 'Számla nettó összege a számla pénznemében',
        hufAmount: 'Számla nettó összege forintban',
        eurRate: 'Alkalmazott árfolyam'
    },
    
    columnIndexes: {
        invoiceNum: -1,
        issueDate: -1,
        performanceDate: -1,
        currency: -1,
        eurAmount: -1,
        hufAmount: -1,
        eurRate: -1
    },
    
    ratePolicy: 'performance', // 'performance', 'issue', vagy 'auto'
    searchDays: 30
};

let dataTable = null;
let processedData = [];
let rawExcelData = null;

// DOM elemek
const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const tableBody = document.getElementById('tableBody');

// Konfiguráció betöltése
function loadConfig() {
    CONFIG.columns.invoiceNum = document.getElementById('configInvoiceNum').value;
    CONFIG.columns.issueDate = document.getElementById('configDate').value;
    CONFIG.columns.performanceDate = document.getElementById('configPerformanceDate').value;
    CONFIG.columns.currency = document.getElementById('configCurrency').value;
    CONFIG.columns.eurAmount = document.getElementById('configEurAmount').value;
    CONFIG.columns.hufAmount = document.getElementById('configHufAmount').value;
    CONFIG.columns.eurRate = document.getElementById('configEurRate').value;
    CONFIG.headerRow = parseInt(document.getElementById('configHeaderRow').value) - 1;
    
    const selectedPolicy = document.querySelector('input[name="ratePolicy"]:checked');
    if (selectedPolicy) {
        CONFIG.ratePolicy = selectedPolicy.value;
        
        if (CONFIG.ratePolicy === 'performance') {
            document.getElementById('policyDescription').innerText = 'Teljesítés dátuma szerint (ÁFA törvény)';
        } else if (CONFIG.ratePolicy === 'issue') {
            document.getElementById('policyDescription').innerText = 'Kiállítás dátuma szerint (kivételes esetek)';
        } else {
            document.getElementById('policyDescription').innerText = 'Automatikus összehasonlítás';
        }
    }
    
    console.log('Konfiguráció betöltve:', CONFIG);
}

// Oszlop indexek keresése
function findColumnIndexes(headerRow) {
    const indexes = {};
    
    console.log('Fejléc sor:', headerRow);
    
    for (const [key, columnName] of Object.entries(CONFIG.columns)) {
        const index = headerRow.findIndex(cell => {
            if (cell === null || cell === undefined) return false;
            const cellStr = cell.toString().trim().toLowerCase();
            const searchStr = columnName.toString().trim().toLowerCase();
            return cellStr === searchStr;
        });
        
        indexes[key] = index !== -1 ? index : -1;
        console.log(`Oszlop '${columnName}' keresése... Találat: ${index !== -1 ? 'igen (index: ' + index + ')' : 'nem'}`);
    }
    
    return indexes;
}

// Szám érték kinyerése
function parseNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    
    if (typeof value === 'number') return value;
    
    if (typeof value === 'string') {
        let cleaned = value.replace(/[^\d.,\-]/g, '')
                          .replace(',', '.')
                          .replace(/\.(?=.*\.)/g, '');
        
        const num = parseFloat(cleaned);
        return isNaN(num) ? null : num;
    }
    
    return null;
}

// Dátum formázása megjelenítéshez
function formatDateForDisplay(dateValue) {
    if (!dateValue) return '-';
    
    if (typeof dateValue === 'number') {
        const date = new Date((dateValue - 25569) * 86400 * 1000);
        return date.toLocaleDateString('hu-HU');
    }
    
    return dateValue.toString();
}

// Dátum összehasonlítás (egyenlő-e)
function areDatesEqual(date1, date2) {
    if (!date1 || !date2) return false;
    
    const d1 = formatDate(date1);
    const d2 = formatDate(date2);
    
    return d1 === d2;
}

// Adatok feldolgozása
function processExcelData(data, headerRowIndex) {
    if (!data || data.length <= headerRowIndex) {
        console.error('Nincs elegendő sor az Excel fájlban');
        return [];
    }
    
    const headerRow = data[headerRowIndex];
    CONFIG.columnIndexes = findColumnIndexes(headerRow);
    
    const missingColumns = [];
    for (const [key, index] of Object.entries(CONFIG.columnIndexes)) {
        if (index === -1 && key !== 'performanceDate') { // Teljesítés dátum nem kötelező
            missingColumns.push(CONFIG.columns[key]);
        }
    }
    
    if (missingColumns.length > 0) {
        console.warn(`Hiányzó oszlopok: ${missingColumns.join(', ')}`);
        
        if (missingColumns.includes(CONFIG.columns.issueDate)) {
            alert('A kiállítás dátum oszlop nem található! Ellenőrizze a "Számla kelte" oszlop nevét.');
            return [];
        }
    }
    
    const processed = [];
    
    for (let i = headerRowIndex + 1; i < data.length; i++) {
        const row = data[i];
        
        if (!row || row.length === 0 || row.every(cell => cell === undefined || cell === null || cell === '')) {
            continue;
        }
        
        // Pénznem ellenőrzés
        if (CONFIG.columnIndexes.currency !== -1) {
            const currency = row[CONFIG.columnIndexes.currency];
            const currencyStr = currency ? currency.toString().trim().toUpperCase() : '';
            
            if (currencyStr !== 'EUR') {
                continue;
            }
        }
        
        // Árfolyam oszlop ellenőrzés
        if (CONFIG.columnIndexes.eurRate !== -1) {
            const eurRateValue = row[CONFIG.columnIndexes.eurRate];
            if (eurRateValue === null || eurRateValue === undefined || eurRateValue === '') {
                continue;
            }
        }
        
        // Alapadatok kinyerése
        const invoiceNum = CONFIG.columnIndexes.invoiceNum !== -1 ? row[CONFIG.columnIndexes.invoiceNum] || '' : '';
        const issueDateValue = CONFIG.columnIndexes.issueDate !== -1 ? row[CONFIG.columnIndexes.issueDate] : null;
        const performanceDateValue = CONFIG.columnIndexes.performanceDate !== -1 ? row[CONFIG.columnIndexes.performanceDate] : null;
        const eurAmount = CONFIG.columnIndexes.eurAmount !== -1 ? parseNumber(row[CONFIG.columnIndexes.eurAmount]) : null;
        const hufAmount = CONFIG.columnIndexes.hufAmount !== -1 ? parseNumber(row[CONFIG.columnIndexes.hufAmount]) : null;
        const excelEurRate = CONFIG.columnIndexes.eurRate !== -1 ? parseNumber(row[CONFIG.columnIndexes.eurRate]) : null;
        
        // Fő dátum meghatározása a választott politika szerint
        let primaryDate = null;
        let secondaryDate = null;
        let primaryDateType = '';
        let secondaryDateType = '';
        
        if (CONFIG.ratePolicy === 'performance') {
            primaryDate = performanceDateValue || issueDateValue; // Ha nincs teljesítés dátum, használjuk a kiállítást
            primaryDateType = 'teljesítés';
            secondaryDate = issueDateValue;
            secondaryDateType = 'kiállítás';
        } else if (CONFIG.ratePolicy === 'issue') {
            primaryDate = issueDateValue;
            primaryDateType = 'kiállítás';
            secondaryDate = performanceDateValue;
            secondaryDateType = 'teljesítés';
        } else { // auto
            primaryDate = issueDateValue;
            primaryDateType = 'kiállítás';
            secondaryDate = performanceDateValue;
            secondaryDateType = 'teljesítés';
        }
        
        if (!primaryDate || eurAmount === null || excelEurRate === null) {
            continue;
        }
        
        // Árfolyam keresés az elsődleges dátumra
        const primaryMnbResult = getMnbRate(primaryDate, RATE_TYPE.CURRENT_DAY);
        const primaryRate = primaryMnbResult ? primaryMnbResult.rate : null;
        const primaryGenerated = primaryMnbResult ? primaryMnbResult.generated : false;
        const primaryAppliedDate = primaryMnbResult ? primaryMnbResult.appliedDate : null;
        
        // Árfolyam keresés a másodlagos dátumra (ha van)
        let secondaryMnbResult = null;
        let secondaryRate = null;
        let secondaryGenerated = false;
        let secondaryAppliedDate = null;
        
        if (secondaryDate && !areDatesEqual(primaryDate, secondaryDate)) {
            secondaryMnbResult = getMnbRate(secondaryDate, RATE_TYPE.CURRENT_DAY);
            secondaryRate = secondaryMnbResult ? secondaryMnbResult.rate : null;
            secondaryGenerated = secondaryMnbResult ? secondaryMnbResult.generated : false;
            secondaryAppliedDate = secondaryMnbResult ? secondaryMnbResult.appliedDate : null;
        }
        
        // Melyik dátummal van egyezés?
        let matchingType = 'none';
        let matchingDate = null;
        let matchingRate = null;
        let matchingGenerated = false;
        let dayDifference = null;
        let foundRates = null;
        
        const tolerance = 0.01;
        
        // Ellenőrizzük az elsődleges dátumot
        if (primaryRate !== null && Math.abs(excelEurRate - primaryRate) < tolerance) {
            matchingType = 'primary';
            matchingDate = primaryAppliedDate;
            matchingRate = primaryRate;
            matchingGenerated = primaryGenerated;
            dayDifference = 0;
        }
        // Ha nem egyezik az elsődlegessel, ellenőrizzük a másodlagosat
        else if (secondaryRate !== null && Math.abs(excelEurRate - secondaryRate) < tolerance) {
            matchingType = 'secondary';
            matchingDate = secondaryAppliedDate;
            matchingRate = secondaryRate;
            matchingGenerated = secondaryGenerated;
            dayDifference = 0;
        }
        // Ha egyikkel sem egyezik, keressünk a 30 napos időablakban
        else {
            foundRates = findRateInWindow(primaryDate, excelEurRate, CONFIG.searchDays);
            
            if (foundRates && foundRates.length > 0) {
                const bestMatch = foundRates[0];
                matchingType = 'found_in_window';
                matchingDate = bestMatch.date;
                matchingRate = bestMatch.rate;
                matchingGenerated = bestMatch.generated;
                dayDifference = bestMatch.dayDiff;
                if (bestMatch.direction === 'backward') {
                    dayDifference = -dayDifference;
                }
            }
        }
        
        // Számított HUF összeg
        const calculatedHuf = (eurAmount && matchingRate) ? Math.round(eurAmount * matchingRate) : null;
        
        // Eltérés számítása
        let difference = null;
        let differencePercent = null;
        let diffClass = '';
        
        if (hufAmount !== null && calculatedHuf !== null) {
            difference = hufAmount - calculatedHuf;
            differencePercent = calculatedHuf !== 0 ? (difference / calculatedHuf * 100) : 0;
            
            if (Math.abs(difference) < 0.5) {
                diffClass = 'difference-zero';
            } else if (difference > 0) {
                diffClass = 'difference-positive';
            } else {
                diffClass = 'difference-negative';
            }
        }
        
        processed.push({
            invoiceNum,
            issueDate: issueDateValue,
            issueDateDisplay: formatDateForDisplay(issueDateValue),
            performanceDate: performanceDateValue,
            performanceDateDisplay: performanceDateValue ? formatDateForDisplay(performanceDateValue) : '-',
            eurAmount,
            hufAmount,
            excelEurRate,
            primaryRate,
            primaryDateType,
            secondaryRate,
            secondaryDateType,
            matchingType,
            matchingDate,
            matchingRate,
            matchingGenerated,
            dayDifference,
            foundRates: foundRates ? foundRates.slice(0, 3) : null,
            calculatedHuf,
            difference,
            differencePercent,
            diffClass,
            rawRow: row
        });
    }
    
    console.log(`Feldolgozott sorok száma: ${processed.length}`);
    if (processed.length > 0) {
        console.log('Első feldolgozott sor:', processed[0]);
    }
    
    return processed;
}

// Tábla megjelenítése
function renderTable(data) {
    tableBody.innerHTML = '';
    
    if (data.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="14" class="text-center">Nincs megjeleníthető adat</td></tr>';
        return;
    }
    
    let positiveDiff = 0;
    let negativeDiff = 0;
    let generatedCount = 0;
    let matchPrimaryCount = 0;
    let matchSecondaryCount = 0;
    let matchFoundCount = 0;
    
    data.forEach((row) => {
        const tr = document.createElement('tr');
        
        if (row.diffClass) {
            tr.className = row.diffClass;
        }
        
        if (row.matchingGenerated) {
            tr.classList.add('generated-rate');
            generatedCount++;
        }
        
        if (row.matchingType === 'primary') {
            tr.classList.add('matches-primary');
            matchPrimaryCount++;
        } else if (row.matchingType === 'secondary') {
            tr.classList.add('matches-secondary');
            matchSecondaryCount++;
        } else if (row.matchingType === 'found_in_window') {
            tr.classList.add('matches-found');
            matchFoundCount++;
        }
        
        const formatNumber = (num, decimals = 0) => {
            if (num === null || num === undefined) return '-';
            return new Intl.NumberFormat('hu-HU', { 
                minimumFractionDigits: decimals, 
                maximumFractionDigits: decimals 
            }).format(num);
        };
        
        const formatPercent = (num) => {
            if (num === null || num === undefined) return '-';
            return new Intl.NumberFormat('hu-HU', { 
                minimumFractionDigits: 2, 
                maximumFractionDigits: 2 
            }).format(num) + '%';
        };
        
        if (row.difference > 0) positiveDiff++;
        if (row.difference < 0) negativeDiff++;
        
        const primaryRateDisplay = row.primaryRate ? 
            formatNumber(row.primaryRate, 2) + (row.primaryDateType === 'teljesítés' ? '' : '') : 
            '-';
        
        const secondaryRateDisplay = row.secondaryRate ? 
            formatNumber(row.secondaryRate, 2) + (row.secondaryDateType === 'teljesítés' ? '' : '') : 
            '-';
        
        const matchingRateDisplay = row.matchingRate ? 
            formatNumber(row.matchingRate, 2) + (row.matchingGenerated ? '*' : '') : 
            '-';
        
        const dayDiffDisplay = row.dayDifference !== null ? 
            (row.dayDifference > 0 ? `+${row.dayDifference} nap` : 
             row.dayDifference < 0 ? `${row.dayDifference} nap` : '0 nap') : '-';
        
        // Egyezés jelölő
        let matchIndicator = '';
        if (row.matchingType === 'primary') {
            matchIndicator = `<span class="badge bg-success">${row.primaryDateType} szerint</span>`;
        } else if (row.matchingType === 'secondary') {
            matchIndicator = `<span class="badge bg-info">${row.secondaryDateType} szerint</span>`;
        } else if (row.matchingType === 'found_in_window') {
            matchIndicator = `<span class="badge bg-warning text-dark">Találat: ${dayDiffDisplay}</span>`;
        } else {
            matchIndicator = '<span class="badge bg-secondary">Nincs egyezés</span>';
        }
        
        // Teljesítés és kiállítás dátum összehasonlítása
        const datesEqual = row.performanceDate && row.issueDate ? 
            areDatesEqual(row.performanceDate, row.issueDate) : false;
        
        tr.innerHTML = `
            <td>${row.invoiceNum || '-'}</td>
			<td class="text-center">${matchIndicator}</td>
            <td>${row.issueDateDisplay}</td>
            <td>${row.performanceDateDisplay}</td>
            <td class="text-end">${formatNumber(row.eurAmount, 2)}</td>
            <td class="text-end">${formatNumber(row.hufAmount, 0)}</td>
            <td class="text-end">${formatNumber(row.excelEurRate, 2)}</td>
            <td class="text-end">${primaryRateDisplay}</td>
            <td class="text-end">${secondaryRateDisplay}</td>
            <td class="text-end">${matchingRateDisplay}</td>
            <td>${row.matchingDate || '-'}</td>
            <td class="text-end">${formatNumber(row.calculatedHuf, 0)}</td>
            <td class="text-end">${formatNumber(row.difference, 0)}</td>
            <td class="text-end">${formatPercent(row.differencePercent)}</td>
            
        `;
        
        tableBody.appendChild(tr);
    });
        
    const generatedInfo = document.createElement('div');
    generatedInfo.className = 'alert alert-info mt-3';
    generatedInfo.innerHTML = `
        <div class="row">
            <div class="col-md-2">
                <i class="fas fa-info-circle me-2"></i>
                Összes: <strong>${data.length}</strong>
            </div>
            <div class="col-md-2">
                <i class="fas fa-calendar-week me-2"></i>
                Generált: <strong>${generatedCount}</strong>
            </div>
            <div class="col-md-2">
                <i class="fas fa-check-circle me-2 text-success"></i>
                ${data[0]?.primaryDateType}: <strong>${matchPrimaryCount}</strong>
            </div>
            <div class="col-md-2">
                <i class="fas fa-check-circle me-2 text-info"></i>
                ${data[0]?.secondaryDateType}: <strong>${matchSecondaryCount}</strong>
            </div>
            <div class="col-md-2">
                <i class="fas fa-search me-2 text-warning"></i>
                Találat: <strong>${matchFoundCount}</strong>
            </div>
            <div class="col-md-2">
                <i class="fas fa-arrow-up me-2 text-danger"></i>
                +: <strong>${positiveDiff}</strong> | 
                <i class="fas fa-arrow-down me-2 text-success"></i>
                -: <strong>${negativeDiff}</strong>
            </div>
        </div>
    `;
    
    const existingInfo = document.querySelector('.generated-info');
    if (existingInfo) {
        existingInfo.remove();
    }
    generatedInfo.classList.add('generated-info');
    
    const tableContainer = document.querySelector('.table-container');
    if (tableContainer) {
        tableContainer.insertBefore(generatedInfo, tableContainer.firstChild);
    }
        
    if (dataTable) {
        dataTable.destroy();
    }
dataTable = $('#dataTable').DataTable({
    language: {
        url: 'https://cdn.datatables.net/plug-ins/1.13.6/i18n/hu.json'
    },
    dom: 'Bfrtip',
    buttons: [
        {
            extend: 'csv',
            text: 'CSV letöltés',
            className: 'btn btn-secondary',
            bom: true
        },
        {
            extend: 'excelHtml5',
            text: 'Excel letöltés',
            className: 'btn btn-success',
            title: 'Adattábla exportálása', // A fájl neve és a táblázat címe az Excelben
            exportOptions: {
                columns: ':visible' // Csak a látható oszlopokat mentse el
            }
        }
    ],
    pageLength: 25,
    order: [[1, 'desc']],
    columnDefs: [
        { type: 'num', targets: [3, 4, 5, 6, 7, 8, 10, 11] },
        { type: 'num-fmt', targets: [12] },
        { type: 'string', targets: [0, 1, 2, 9, 13] }
    ],
    destroy: true,
    retrieve: true,
    scrollX: true,
    responsive: false
});
}

// Eseménykezelők
document.querySelectorAll('input[name="ratePolicy"]').forEach(radio => {
    radio.addEventListener('change', () => {
        loadConfig();
        if (rawExcelData) {
            processedData = processExcelData(rawExcelData, CONFIG.headerRow);
            if (processedData.length > 0) {
                renderTable(processedData);
            }
        }
    });
});

uploadArea.addEventListener('click', () => {
    fileInput.click();
});

uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.style.borderColor = '#0d6efd';
    uploadArea.style.backgroundColor = '#e9ecef';
});

uploadArea.addEventListener('dragleave', () => {
    uploadArea.style.borderColor = '#dee2e6';
    uploadArea.style.backgroundColor = '#f8f9fa';
});

uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.style.borderColor = '#dee2e6';
    uploadArea.style.backgroundColor = '#f8f9fa';
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
        loadConfig();
        processExcel(files[0]);
    }
});

const btnProcess = document.getElementById('btn-process');

// 2. Amikor változik a file input, csak megjegyezzük a fájlt
fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        selectedFile = e.target.files[0];
        // Opcionális: itt engedélyezheted a gombot, ha alapból le van tiltva
        btnProcess.disabled = false; 
    }
});

// 3. A tényleges feldolgozás indítása a gombnyomásra
btnProcess.addEventListener('click', () => {
    if (selectedFile) {
        loadConfig();
        processExcel(selectedFile);
    } else {
        alert("Kérlek, előbb válassz ki egy fájlt!");
    }
});

function processExcel(file) {
    const reader = new FileReader();
    
    reader.onload = function(e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '' });
            
            console.log('Excel betöltve, sorok száma:', jsonData.length);
            rawExcelData = jsonData;
            
            processedData = processExcelData(jsonData, CONFIG.headerRow);
            
            if (processedData.length > 0) {
                renderTable(processedData);
            } else {
                alert('Nincs feldolgozható adat az Excel fájlban!');
            }
            
        } catch (error) {
            console.error('Hiba az Excel feldolgozása során:', error);
            alert('Hiba történt az Excel fájl feldolgozása során: ' + error.message);
        }
    };
    
    reader.readAsArrayBuffer(file);
}

document.getElementById('availableRatesCount').textContent = MNB_RATES.data.length;

const ts = MNB_RATES.ts;

document.getElementById('updateMNB').textContent = 
    `${ts.slice(0,4)}.${ts.slice(4,6)}.${ts.slice(6,8)}. ${ts.slice(8,10)}:${ts.slice(10,12)}`;

loadConfig();
console.log('App inicializálva');