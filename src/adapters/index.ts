import * as dialogflow from './dialogflow';
import * as luis from './luis';
import * as rasa from './rasa';
import * as rasa2 from './rasa2';
import * as snips from './snips';
import * as web from './web';

export type Adapter = typeof dialogflow | typeof luis | typeof rasa | typeof rasa2 | typeof snips | typeof web;

export const adapters: { [key: string]: Adapter } = { default: web, rasa, rasa2, snips, luis, dialogflow, web };
