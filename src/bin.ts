#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { adapters } from './adapters';
import { defaultAccumulator } from './adapters/accumulators';

// tslint:disable-next-line:no-var-requires
const argv = require('minimist')(process.argv.slice(2));

const workingDirectory = process.cwd();
const getFileWithPath = (filename: string) => path.resolve(workingDirectory, filename);

const collectChatitoFiles = (startPath: string, filenames: string[]) => {
    if (!fs.existsSync(startPath)) {
        // tslint:disable-next-line:no-console
        console.error(`No such file or directory: ${startPath}`);
        process.exit(1);
    }
    const stat = fs.lstatSync(startPath);
    if (stat.isDirectory()) {
        const files = fs.readdirSync(startPath);
        for (const file of files) {
            const filename = path.join(startPath, file);
            collectChatitoFiles(filename, filenames);
        }
    } else if (/\.chatito$/.test(startPath)) {
        filenames.push(startPath);
    }
};

const importer = (fromPath: string, importFile: string) => {
    const filePath = path.resolve(path.dirname(fromPath), importFile);
    if (path.extname(filePath) !== '.chatito') {
        throw new Error('Only files with .chatito extension can be imported');
    }
    if (!fs.existsSync(filePath)) {
        throw new Error(`Can't import ${filePath}`);
    }
    const dsl = fs.readFileSync(filePath, 'utf8');
    return { filePath, dsl };
};

(async () => {
    if (!argv._ || !argv._.length) {
        // tslint:disable-next-line:no-console
        console.error('Invalid chatito file.');
        process.exit(1);
    }
    const configFile = argv._[0];
    const inputFormat = (argv.format || 'default').toLowerCase();
    if (['default', 'rasa', 'rasa2', 'snips', 'luis', 'dialogflow'].indexOf(inputFormat) === -1) {
        // tslint:disable-next-line:no-console
        console.error(`Invalid format argument: ${inputFormat}`);
        process.exit(1);
    }
    const format: 'default' | 'rasa' | 'rasa2' | 'snips' | 'luis' | 'dialogflow' = inputFormat;
    const outputPath = argv.outputPath || process.cwd();
    try {
        // parse the formatOptions argument
        let formatOptions = null;
        if (argv.formatOptions) {
            formatOptions = JSON.parse(fs.readFileSync(path.resolve(argv.formatOptions), 'utf8'));
        }
        const dslFilePath = getFileWithPath(configFile);
        const filenames: string[] = [];
        collectChatitoFiles(dslFilePath, filenames);
        const adapter = adapters[format];
        if ('processFiles' in adapter) {
            await adapter.processFiles(filenames, formatOptions, importer, outputPath, argv.trainingFileName, argv.testingFileName);
        } else {
            const accumulator = defaultAccumulator(adapter, importer, formatOptions, argv.trainingFileName, argv.testingFileName);
            for (const filename of filenames) {
                await accumulator.write(filename);
            }
            accumulator.save(outputPath);
        }
    } catch (e) {
        // tslint:disable:no-console
        if (e && e.message && e.location) {
            console.log('==== CHATITO SYNTAX ERROR ====');
            console.log('    ', e.message);
            console.log(`     Line: ${e.location.start.line}, Column: ${e.location.start.column}`);
            console.log('==============================');
        } else {
            console.error(e && e.stack ? e.stack : e);
        }
        console.log('FULL ERROR REPORT:');
        console.error(e);
        // tslint:enable:no-console
        process.exit(1);
    }
})();
