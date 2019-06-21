import * as fs from 'fs';
import * as gen from '../main';
import { ISentenceTokens } from '../types';
import * as utils from '../utils';
import { IRasaDataset, IRasaEntity, IRasaExample, IRasaTestingDataset } from './rasa';

export const name = 'rasa2';

export function processFiles(filenames: string[], formatOptions: any, importer: gen.IFileImporter, outputPath: string) {
    for (const filename of filenames) {
        const dsl = fs.readFileSync(filename, 'utf8');

    }
}

export async function adapter(dsl: string, formatOptions?: any, importer?: gen.IFileImporter, currentPath?: string) {
    const training: IRasaDataset = {
        rasa_nlu_data: {
            regex_features: [],
            entity_synonyms: [],
            common_examples: []
        }
    };
    const testing = { rasa_nlu_data: { common_examples: [] as IRasaExample[] } };
    const synonyms: { [entityName: string]: { [original: string]: Set<string> } } = {};
    const reverseSynonyms: { [entityName: string]: { [synonym: string]: string } } = {};
    const allSynonyms: { [original: string]: Set<string> } = {};
    if (formatOptions) {
        utils.mergeDeep(training, formatOptions);
    }
    // Collect the synonyms first
    const defs = gen.definitionsFromAST(gen.astFromString(dsl), importer, currentPath);
    if (!defs) {
        return { training, testing };
    }
    Object.keys(defs.Slot).forEach(key => {
        const slot = defs.Slot[key];
        if (!slot.args || !slot.args.entity) {
            // It's not a synonym if it has no entity argument
            return;
        }
        const entityName = slot.args.entity;
        let value = slot.key;
        if (slot.args && slot.args.value) {
            value = slot.args.value;
        }
        if (!(entityName in synonyms)) {
            synonyms[entityName] = {};
            reverseSynonyms[entityName] = {};
        }
        if (!(value in synonyms[entityName])) {
            synonyms[entityName][value] = new Set();
        }
        if (!(value in allSynonyms)) {
            allSynonyms[value] = new Set<string>();
        }
        // get all combinations for a slot
        const slotSynonyms = gen.getAllExamples(defs, slot).map(example => example.reduce((acc, token) => acc + token.value, ''));
        slotSynonyms.forEach(synonym => {
            synonyms[entityName][value].add(synonym);
            reverseSynonyms[entityName][synonym] = value;
            allSynonyms[value].add(synonym);
        });
    });

    // Then the examples
    const utteranceWriter = (utterance: ISentenceTokens[], intentKey: string, isTrainingExample: boolean) => {
        const example = utterance.reduce(
            (acc, next) => {
                if (next.type === 'Slot' && next.slot) {
                    let entityName = next.slot;
                    let originalValue = next.value;
                    if (next.args && next.args.entity) {
                        entityName = next.args.entity;
                    }
                    // Check if it's a synonym
                    if (reverseSynonyms[entityName] && next.value in reverseSynonyms[entityName]) {
                        originalValue = reverseSynonyms[entityName][next.value];
                    }
                    acc.entities.push({
                        end: acc.text.length + next.value.length,
                        entity: entityName,
                        start: acc.text.length,
                        value: originalValue
                    });
                }
                acc.text += next.value;
                return acc;
            },
            { text: '', intent: intentKey, entities: [] } as IRasaExample
        );
        if (isTrainingExample) {
            training.rasa_nlu_data.common_examples.push(example);
        } else {
            testing.rasa_nlu_data.common_examples.push(example);
        }
    };
    await gen.datasetFromString(dsl, utteranceWriter, importer, currentPath);
    Object.keys(allSynonyms).forEach(k => {
        training.rasa_nlu_data.entity_synonyms.push({
            synonyms: [...allSynonyms[k]],
            value: k
        });
    });
    return { training, testing };
}
