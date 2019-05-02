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
}

export async function adapter(dsl: string, formatOptions?: any) {
    const training = { data: [] } as IDialogflowDataset;
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
    return { training, testing };
}
