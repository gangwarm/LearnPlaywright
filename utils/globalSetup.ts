import { FullConfig } from '@playwright/test';
import * as XLSX from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';

async function globalSetup(config: FullConfig) {
    console.log('🔄 Enterprise Setup: Generating Nested Page-Object JSON...');
    
    const excelPath = path.join(__dirname, '../data/testRegistry.xlsx');
    const jsonPath = path.join(__dirname, '../data/testRegistry.json');

    if (!fs.existsSync(excelPath)) throw new Error(`❌ Excel not found!`);

    const workbook = XLSX.readFile(excelPath);
    const sheetNames = workbook.SheetNames;
    const registrySheet: any[] = XLSX.utils.sheet_to_json(workbook.Sheets['Registry']);
    const dataSheets = sheetNames.filter(name => name !== 'Registry');

    const finalData = registrySheet.map((regRow: any) => {
        const tcId = regRow.TestCaseID;
        const nestedData: any = {};

        // Loop through every data sheet (Login, ProductPage, Cart, etc.)
        for (const sheetName of dataSheets) {
            const sheetData: any[] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
            
            // Find the specific row for this TestCaseID in the current sheet
            const match = sheetData.find(row => row.TestCaseID === tcId);
            
            if (match) {
                // NEST the data under the Sheet Name
                nestedData[sheetName] = match;
            }
        }

        return {
            metadata: {
                tcId: tcId,
                title: regRow.Description,
                priority: regRow.Priority,
                testType: regRow.TestType,
                tags: regRow.Tags ? regRow.Tags.split(',').map((t: string) => t.trim()) : []
            },
            execution: {
                enabled: regRow.Run === 'Yes' || regRow.Run === true,
                environment: regRow.Environment,
                browser: regRow.Browser
            },
            data: nestedData // This is now organized by sheet name
        };
    });

    fs.writeFileSync(jsonPath, JSON.stringify(finalData, null, 2));
    console.log(`✅ Success! Nested data generated for ${dataSheets.length} pages.`);
}

export default globalSetup;