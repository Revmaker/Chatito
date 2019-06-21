import * as fs from 'fs';
import * as path from 'path';
import * as gen from '../main';
import { ISentenceTokens } from '../types';

export const name = 'dialogflow';

export interface IDialogflowEntity {
    text: string;
    alias?: string;
    meta?: string;
    userDefined: false;
}

export interface IDialogflowExample {
    data: IDialogflowEntity[];
    isTemplate: boolean;
    count: number;
}

export interface IDialogflowDataset {
    intents: {
        [intent: string]: {
            data: IDialogflowExample[];
            parameters: {
                [name: string]: string;
            };
        };
    };
    synonyms: {
        [entity: string]: {
            [value: string]: string[];
        };
    };
}

interface IDialogflowIntentParamConfig {
    required: boolean;
    dataType: string;
    name: string;
    value: string;
    isList: boolean;
}

const defaultIntentConfig = {
    name: '',
    auto: true,
    contexts: [] as Array<{}>,
    responses: [
        {
            resetContexts: false,
            action: '',
            affectedContexts: [] as Array<{}>,
            parameters: [] as IDialogflowIntentParamConfig[],
            messages: [
                {
                    type: 0,
                    lang: '',
                    speech: [] as Array<{}>
                }
            ],
            defaultResponsePlatforms: {},
            speech: [] as Array<{}>
        }
    ],
    priority: 500000,
    webhookUsed: false,
    webhookForSlotFilling: false,
    fallbackIntent: false,
    events: [] as Array<{}>
};

type DialogflowIntentConfig = typeof defaultIntentConfig;

export function save(trainingDataset: IDialogflowDataset, testingDataset: IDialogflowDataset, outputPath: string, formatOptions: any) {
    for (const intent of Object.keys(trainingDataset.intents)) {
        const examples = trainingDataset.intents[intent].data.length;
        let index = 1;
        const perFile = 2000;
        let language = 'en';

        // Pick language from the agent if possible
        const agentConfigFile = path.resolve(outputPath, 'agent.json');
        if (fs.existsSync(agentConfigFile)) {
            language = JSON.parse(fs.readFileSync(agentConfigFile, 'utf8')).language;
        }

        let intentSuffix = '';
        if (formatOptions && 'intentSuffix' in formatOptions) {
            intentSuffix = formatOptions.intentSuffix;
        }

        if (formatOptions && 'language' in formatOptions) {
            language = formatOptions.language;
        }

        if (!fs.existsSync(path.resolve(outputPath, 'intents'))) {
            fs.mkdirSync(path.resolve(outputPath, 'intents'));
        }

        while ((index - 1) * perFile < examples) {
            const intentName = `${intent}${intentSuffix}${index}`;
            const trainingJsonFileName = `${intentName}_usersays_${language}.json`;
            const trainingJsonFilePath = path.resolve(outputPath, 'intents', trainingJsonFileName);
            fs.writeFileSync(
                trainingJsonFilePath,
                JSON.stringify(trainingDataset.intents[intent].data.slice((index - 1) * perFile, index * perFile), undefined, 2)
            );
            // Check intent settings
            const intentConfigFile = path.resolve(outputPath, 'intents', `${intentName}.json`);
            if (fs.existsSync(intentConfigFile)) {
                // Merge parameters
                const intentConfig: DialogflowIntentConfig = JSON.parse(fs.readFileSync(intentConfigFile, 'utf8'));
                Object.keys(trainingDataset.intents[intent].parameters).forEach(alias => {
                    if (!intentConfig.responses[0].parameters.find(parameter => parameter.name === alias)) {
                        intentConfig.responses[0].parameters.push({
                            required: false,
                            dataType: `@${trainingDataset.intents[intent].parameters[alias]}`,
                            name: alias,
                            value: `$${alias}`,
                            isList: true
                        });
                    }
                });
                fs.writeFileSync(intentConfigFile, JSON.stringify(intentConfig, undefined, 2));
            } else {
                const intentConfig: DialogflowIntentConfig = JSON.parse(JSON.stringify(defaultIntentConfig));
                intentConfig.name = intentName;
                intentConfig.responses[0].action = intent;
                intentConfig.responses[0].messages[0].lang = language;
                intentConfig.responses[0].parameters = Object.keys(trainingDataset.intents[intent].parameters).map(alias => ({
                    required: false,
                    dataType: `@${trainingDataset.intents[intent].parameters[alias]}`,
                    name: alias,
                    value: `$${alias}`,
                    isList: true
                }));
                fs.writeFileSync(intentConfigFile, JSON.stringify(intentConfig, undefined, 2));
            }
            // tslint:disable-next-line:no-console
            console.log(`Saved training dataset: ${trainingJsonFilePath}`);
            index += 1;
        }
    }

    // Do not merge synonyms if output path is not an agent dir
    if (!fs.existsSync(path.resolve(outputPath, 'entities'))) {
        return;
    }

    // Merge synonyms
    Object.keys(trainingDataset.synonyms)
        .filter(entity => !entity.startsWith('sys.'))
        .forEach(entity => {
            const entriesFile = path.resolve(`${outputPath}/entities/${entity}_entries_en.json`);
            const entries: Array<{ value: string; synonyms: string[] }> = JSON.parse(fs.readFileSync(entriesFile, 'utf8'));
            Object.keys(trainingDataset.synonyms[entity]).forEach(entry => {
                const synonyms = trainingDataset.synonyms[entity][entry];
                // console.log(`Our synonyms for ${entry}`, synonyms);
                const i = entries.findIndex(e => e.value === entry);
                if (i === -1) {
                    // console.log(`They don't have synonyms for ${entry}`);
                    entries.push({
                        value: entry,
                        synonyms
                    });
                } else {
                    // console.log(`Their synonyms for ${entry}`, entries[i].synonyms);
                    synonyms.forEach(synonym => {
                        if (entries[i].synonyms.indexOf(synonym) === -1) {
                            entries[i].synonyms.push(synonym);
                        }
                    });
                    entries[i].synonyms.forEach(synonym => {
                        if (synonyms.indexOf(synonym) === -1) {
                            // tslint:disable-next-line:no-console
                            console.log(`Destination has extra synonym for ${entity}: ${entry} <-`, synonym);
                        }
                    });
                }
            });
            fs.writeFileSync(entriesFile, JSON.stringify(entries, undefined, 2));
            // console.log(entries);
        });
}

export async function adapter(dsl: string, formatOptions?: any, importer?: gen.IFileImporter, currentPath?: string) {
    const training = { intents: {}, synonyms: {} } as IDialogflowDataset;
    const testing = { intents: {}, synonyms: {} } as IDialogflowDataset;
    const utteranceWriter = (utterance: ISentenceTokens[], intentKey: string, isTrainingExample: boolean) => {
        const intent = intentKey.split('#')[0];
        const writeTo = isTrainingExample ? training.intents : testing.intents;
        if (!(intent in writeTo)) {
            writeTo[intent] = {
                data: [],
                parameters: {}
            };
        }
        const example = utterance.reduce(
            (acc, next) => {
                if (next.type === 'Slot' && next.slot) {
                    let meta = `${next.slot}`;
                    if (next.args && next.args.entity) {
                        meta = next.args.entity;
                    }
                    let alias = meta;
                    if (next.args && next.args.parameter) {
                        alias = next.args.parameter;
                    }
                    acc.data.push({
                        text: next.value,
                        alias,
                        meta: `@${meta}`,
                        userDefined: false
                    });
                    writeTo[intent].parameters[alias] = meta;
                } else {
                    acc.data.push({
                        text: next.value,
                        userDefined: false
                    });
                }
                return acc;
            },
            { data: [], isTemplate: false, count: 0 } as IDialogflowExample
        );
        writeTo[intent].data.push(example);
    };
    await gen.datasetFromString(dsl, utteranceWriter, importer, currentPath);
    const defs = gen.definitionsFromAST(gen.astFromString(dsl), importer, currentPath);
    if (!defs) {
        return { training, testing };
    }
    Object.keys(defs.Slot).forEach(key => {
        const slot = defs.Slot[key];
        if (!slot.args || !slot.args.entity) {
            return;
        }
        const name = slot.args.entity;
        let value = slot.key;
        if (slot.args && slot.args.value) {
            value = slot.args.value;
        }
        if (!(name in training.synonyms)) {
            training.synonyms[name] = {};
        }
        if (!(value in training.synonyms[name])) {
            training.synonyms[name][value] = [];
        }
        // get all combinations for a slot
        const synonyms = gen.getAllExamples(defs, slot).map(example => example.reduce((acc, token) => acc + token.value, ''));
        synonyms.forEach(synonym => {
            if (training.synonyms[name][value].indexOf(synonym) === -1) {
                training.synonyms[name][value].push(synonym);
            }
        });
    });
    return { training, testing };
}
