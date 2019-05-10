import * as gen from '../main';
import { ISentenceTokens } from '../types';

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
    data: IDialogflowExample[];
    synonyms: {
        [entity: string]: {
            [value: string]: string[];
        };
    };
}

export async function adapter(dsl: string, formatOptions?: any) {
    const training = { data: [], synonyms: {} } as IDialogflowDataset;
    const testing = {} as IDialogflowDataset;
    const utteranceWriter = (utterance: ISentenceTokens[], intentKey: string, isTrainingExample: boolean) => {
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
        if (isTrainingExample) {
            training.data.push(example);
        } else {
            testing.data.push(example);
        }
    };
    await gen.datasetFromString(dsl, utteranceWriter);
    const defs = gen.definitionsFromAST(gen.astFromString(dsl));
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
        if (!name) {
            throw Error(`No dialogflow entity specified for ${key}`);
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
