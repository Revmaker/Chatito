import * as fs from 'fs';
import * as path from 'path';
import * as gen from '../main';
import * as utils from '../utils';
import { Adapter } from './';
import * as dialogflow from './dialogflow';
import * as luis from './luis';
import * as rasa from './rasa';
import * as snips from './snips';

export const defaultAccumulator = (
    adapter: Adapter,
    importer: gen.IFileImporter,
    formatOptions?: any,
    trainingFileName?: string,
    testingFileName?: string
) => {
    const trainingDataset: snips.ISnipsDataset | rasa.IRasaDataset | luis.ILuisDataset | dialogflow.IDialogflowDataset | {} = {};
    const testingDataset: any = {};
    return {
        write: async (fullFilenamePath: string) => {
            // tslint:disable-next-line:no-console
            console.log(`Processing file: ${fullFilenamePath}`);
            const dsl = fs.readFileSync(fullFilenamePath, 'utf8');
            const { training, testing } = await adapter.adapter(dsl, formatOptions, importer, fullFilenamePath);
            utils.mergeDeep(trainingDataset, training);
            utils.mergeDeep(testingDataset, testing);
        },
        save: (outputPath: string) => {
            if (!fs.existsSync(outputPath)) {
                fs.mkdirSync(outputPath);
            }

            // Use adapter's own saver if exists
            if ('save' in adapter) {
                adapter.save(trainingDataset as dialogflow.IDialogflowDataset, testingDataset, outputPath, formatOptions);
                return;
            }

            const trainingJsonFileName = trainingFileName || `${adapter.name}_dataset_training.json`;
            const trainingJsonFilePath = path.resolve(outputPath, trainingJsonFileName);
            fs.writeFileSync(trainingJsonFilePath, JSON.stringify(trainingDataset));
            // tslint:disable-next-line:no-console
            console.log(`Saved training dataset: ${trainingJsonFilePath}`);

            if (Object.keys(testingDataset).length) {
                const testingJsonFileName = testingFileName || `${adapter.name}_dataset_testing.json`;
                const testingJsonFilePath = path.resolve(outputPath, testingJsonFileName);
                fs.writeFileSync(testingJsonFilePath, JSON.stringify(testingDataset));
                // tslint:disable-next-line:no-console
                console.log(`Saved testing dataset: ${testingJsonFilePath}`);
            }
        }
    };
};
