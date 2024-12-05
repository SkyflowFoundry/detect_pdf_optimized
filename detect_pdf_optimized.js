const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const { PDFDocument } = require('pdf-lib');
const cliProgress = require('cli-progress');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const accessToken = "-skyflow_access_token-";
const vaultID = "-skyflow_vault_id-";
const vaultURL = "-skyflow_vault_url";
const accountID = '-skyflow_account_id-';
const tableName = "table1";

// Master thread
if (isMainThread) {
    async function loadFileChunks() {
        const filePath = process.argv[2];
        if (!filePath) {
            console.log("Please provide a file path as an argument.");
            process.exit(1);
        }

        const fileType = filePath.split('.').pop();
        const fileBytes = fs.readFileSync(filePath);
        const pdfDoc = await PDFDocument.load(fileBytes);

        const totalPages = pdfDoc.getPages().length;
        const chunkSize = 5;
        const chunks = [];

        console.log(`Loaded ${totalPages} pages ${fileType} file.`)

        for (let i = 0; i < totalPages; i += chunkSize) {
            const chunkDoc = await PDFDocument.create();
            const chunkPages = pdfDoc.getPages().slice(i, i + chunkSize);

            for (let page of chunkPages) {
                const [importedPage] = await chunkDoc.copyPages(pdfDoc, [pdfDoc.getPages().indexOf(page)]);
                chunkDoc.addPage(importedPage);
            }

            const chunkBytes = await chunkDoc.save();
            const chunkBase64 = Buffer.from(chunkBytes).toString('base64');
            chunks.push(chunkBase64);
        }

        console.log(`File broken down into ${chunks.length} chunks.`);

        // Create and start the progress bar
        const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
        progressBar.start(chunks.length, 0);

        let processedCount = 0;
        const processedChunks = await Promise.all(
            chunks.map(
                (chunk, index) =>
                    new Promise((resolve, reject) => {
                        const worker = new Worker(__filename, {
                            workerData: { chunk, fileType, index },
                        });

                        worker.on('message', (message) => {
                            processedCount++;
                            progressBar.update(processedCount);
                            resolve(message);
                        });

                        worker.on('error', reject);

                        worker.on('exit', (code) => {
                            if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
                        });
                    })
            )
        );

        // Stop the progress bar once all chunks are processed
        progressBar.stop();

        await mergeChunksIntoPDF(processedChunks, fileType);
        console.timeEnd('executionTime');
    }

    async function mergeChunksIntoPDF(chunks, fileType) {
        const mergedDoc = await PDFDocument.create();
        for (let chunkBuffer of chunks) {
            const chunkPdf = await PDFDocument.load(chunkBuffer);
            const copiedPages = await mergedDoc.copyPages(chunkPdf, chunkPdf.getPages().map((_, index) => index));
            copiedPages.forEach((page) => mergedDoc.addPage(page));
        }

        const mergedBytes = await mergedDoc.save();
        const filename = 'merged_result_' + Date.now() + '.' + fileType;
        fs.writeFileSync(filename, mergedBytes);
        console.log(`${filename} has been saved.`);
    }

    console.time('executionTime');
    loadFileChunks().catch(console.error);

} else {
    // Worker thread
    const { chunk, fileType, index } = workerData;

    async function processChunk(chunk, fileType, index) {
        try {
            const response = await axios.post(`${vaultURL}/v1/detect/deidentify/file/document/pdf`, {
                file: { base64: chunk, data_format: fileType },
                vault_id: vaultID,
                entity_types: ["all"],
                token_type: {
                    entity_unq_counter: ["name"],
                    entity_only: ["dob"],
                    default: "entity_only",
                },
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`,
                    'X-SKYFLOW-ACCOUNT-ID': accountID,
                },
            });

            const runId = response.data.run_id;
            let detectResponse;

            while (true) {
                const statusResponse = await axios.get(`${vaultURL}/v1/detect/runs/${runId}?vault_id=${vaultID}`, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${accessToken}`,
                        'X-SKYFLOW-ACCOUNT-ID': accountID,
                    },
                });

                detectResponse = statusResponse.data;

                if (detectResponse.status === 'SUCCESS') break;
                if (detectResponse.status === 'FAILED') throw new Error('Processing failed');
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }

            const fileProcessed = detectResponse.output.find(
                (item) => item.processed_file_type.startsWith('redacted_')
            ).processed_file;

            parentPort.postMessage(Buffer.from(fileProcessed, 'base64'));
        } catch (error) {
            console.error(`Error processing chunk #${index}:`, error);
            parentPort.postMessage(null);
        }
    }

    processChunk(chunk, fileType, index).catch(console.error);
}

