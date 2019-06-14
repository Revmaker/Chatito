import { Chance } from 'chance';
import {
    IChatitoCache,
    IChatitoEntityAST,
    IChatitoParser,
    IEntities,
    IEntityDef,
    ISentenceTokens,
    IStatCache,
    IUtteranceWriter
} from './types';
import * as utils from './utils';

// tslint:disable-next-line:no-var-requires
const chatito = require('../parser/chatito') as IChatitoParser;
const chance = new Chance();

const chatitoFormatPostProcess = (data: ISentenceTokens[]) => {
    const arr = data.reduce(
        (accumulator: ISentenceTokens[], next: ISentenceTokens, i, arrShadow) => {
            if (accumulator.length) {
                const lastWord = accumulator[accumulator.length - 1];
                if (lastWord.type === next.type && lastWord.type === 'Text') {
                    accumulator[accumulator.length - 1] = {
                        type: lastWord.type,
                        value: (lastWord.value + next.value).replace(/\s+/g, ' ')
                    };
                } else {
                    accumulator.push(next);
                }
            } else if (next.value.trim()) {
                accumulator.push(next);
            }
            if (i === arrShadow.length - 1) {
                // if its the last token of a sentence
                // remove empty strings at the end
                if (accumulator.length) {
                    if (!accumulator[accumulator.length - 1].value.trim()) {
                        accumulator.pop();
                    }
                    accumulator[accumulator.length - 1] = Object.assign({}, accumulator[accumulator.length - 1], {
                        value: accumulator[accumulator.length - 1].value.replace(/\s+$/g, '')
                    });
                }
            }
            return accumulator;
        },
        [] as ISentenceTokens[]
    );
    if (arr.length) {
        arr[0] = Object.assign({}, arr[0], {
            value: arr[0].value.replace(/^\s+/, '')
        });
    }
    if (!arr.length) {
        throw new Error(`Some sentence generated an empty string. Can't map empty to an intent.`);
    }
    return arr;
};

// recursive function that generates variations using a cache
// that uses counts to avoid repetitions
const getVariationsFromEntity = async <T>(
    ed: IChatitoEntityAST,
    entities: IEntities,
    optional: boolean,
    cache: IChatitoCache
): Promise<ISentenceTokens[]> => {
    // if this entity is a slot variation, add that as the key
    const variationKey = ed.variation ? `#${ed.variation}` : '';
    const cacheKey = `${ed.type}-${ed.key}${variationKey}`;
    let cacheStats = cache.get(cacheKey) as IStatCache;
    if (!cacheStats) {
        // if the entity is not cache, create an empty cache for it
        const counts: IChatitoCache[] = [];
        const maxCounts: number[] = []; // calcs the max possible utterancees for each sentence
        const definedSentenceProbabilities: Array<number | null> = []; // the posibility operators defined for sentences
        const indexesOfSentencesWithNullProbability: number[] = [];
        let sumOfTotalProbabilitiesDefined = 0;
        for (const c of ed.inner) {
            // get counts for each of the sentences inside the entity
            counts.push(new Map());
            let mxc = utils.maxSentencesForSentence(entities)(c);
            if (optional) {
                mxc++;
            }
            maxCounts.push(mxc);
            if (c.probability === null) {
                indexesOfSentencesWithNullProbability.push(definedSentenceProbabilities.length);
                definedSentenceProbabilities.push(null);
            } else {
                const prob = parseInt(c.probability || '', 10);
                if (!Number.isInteger(prob)) {
                    throw new Error(`Probability "${c.probability}" must be an integer value. At ${cacheKey}`);
                }
                if (prob < 1 || prob > 100) {
                    throw new Error(`Probability "${c.probability}" must be from 1 to 100. At ${cacheKey}`);
                }
                sumOfTotalProbabilitiesDefined += prob;
                definedSentenceProbabilities.push(prob);
            }
        }
        if (sumOfTotalProbabilitiesDefined && sumOfTotalProbabilitiesDefined > 100) {
            throw new Error(
                `The sum of sentence probabilities (${sumOfTotalProbabilitiesDefined}) for an entity can't be higher than 100%. At ${cacheKey}`
            );
        }
        // get the sum of all defined posibility operators inside the entity and validate it
        const totalMaxCountsToShareBetweenNullProbSent =
            indexesOfSentencesWithNullProbability.map(i => maxCounts[i]).reduce((p, n) => (p || 0) + (n || 0), 0) || 0;
        // calculate the split of remaining probability for sentences that don't define them
        // const realProbabilities = maxCounts.map(m => (m * 100) / sumOfTotalMax);
        const probabilities = definedSentenceProbabilities.map((p, i) =>
            p === null
                ? (((maxCounts[i] * 100) / totalMaxCountsToShareBetweenNullProbSent) * (100 - sumOfTotalProbabilitiesDefined)) / 100
                : p
        );
        const currentEntityCache: IStatCache = { counts, maxCounts, optional, probabilities };
        cache.set(cacheKey, currentEntityCache);
        cacheStats = cache.get(cacheKey) as IStatCache;
    }
    // NOTE: if an entity has 5 sentences we add one (the optional empty sentence) and get that probability
    const optionalProb = 100 / (cacheStats.probabilities.length + 1);
    let sentenceIndex = chance.weighted(Array.from(cacheStats.probabilities.keys()), cacheStats.probabilities);
    if (cacheStats.optional && chance.bool({ likelihood: optionalProb })) {
        sentenceIndex = -1;
    }
    if (sentenceIndex === -1) {
        return [];
    }
    const sentence = ed.inner[sentenceIndex].sentence;
    let accumulator: ISentenceTokens[] = [];
    // For slots where a sentence is composed of only one alias, we add the synonym tag,
    // to denote that the generated alias is a synonym of its alias name
    const slotSynonyms = ed.type === 'SlotDefinition' && sentence.length === 1 && sentence[0].type === 'Alias';
    for (const t of sentence) {
        // slots and alias entities generate the sentences recursively
        const slotsInSentenceKeys: Set<string> = new Set([]);
        if (t.type === 'Slot' || t.type === 'Alias') {
            const def = entities[t.type];
            const innerEntityKey = t.variation ? `${t.value}#${t.variation}` : t.value;
            const currentCache = slotsInSentenceKeys.has(innerEntityKey) ? cacheStats.counts[sentenceIndex] : new Map();
            slotsInSentenceKeys.add(innerEntityKey);
            const sentenceVariation = await getVariationsFromEntity(def[innerEntityKey], entities, !!t.opt, currentCache);
            if (sentenceVariation.length) {
                const returnSentenceTokens = chatitoFormatPostProcess(sentenceVariation);
                for (const returnToken of returnSentenceTokens) {
                    if (slotSynonyms) {
                        returnToken.synonym = t.value;
                    }
                    if (t.type === 'Slot') {
                        if (def[innerEntityKey].args) {
                            returnToken.args = def[innerEntityKey].args;
                        }
                        returnToken.value = returnToken.value.trim();
                        returnToken.type = t.type;
                        returnToken.slot = t.value;
                    }
                    accumulator = accumulator.concat(returnToken);
                }
            }
        } else {
            accumulator = accumulator.concat(t);
        }
    }
    return accumulator;
};

export type IFileImporter = (
    fromPath: string,
    importFile: string
) => {
    filePath: string;
    dsl: string;
};

export const astFromString = (str: string) => chatito.parse(str);
export const datasetFromString = (str: string, writterFn: IUtteranceWriter, importer?: IFileImporter, currentPath?: string) => {
    const ast = astFromString(str);
    return datasetFromAST(ast, writterFn, importer, currentPath);
};

export const getImports = (from: string, to: string, importer: IFileImporter) => {
    const fileContent = importer(from, to);
    if (!fileContent || !fileContent.dsl) {
        throw new Error(`Failed importing ${to}`);
    }
    try {
        const importAst = astFromString(fileContent.dsl);
        let outAst: IChatitoEntityAST[] = [];
        importAst.forEach(ett => {
            if (ett.type === 'ImportFile' && ett.value) {
                outAst = [...outAst, ...getImports(fileContent.filePath, ett.value, importer)];
            } else if (ett.type === 'AliasDefinition' || ett.type === 'SlotDefinition') {
                outAst = [...outAst, ett];
            }
        });
        return outAst;
    } catch (e) {
        throw new Error(`Failed importing ${to}. ${e.message} - ${JSON.stringify(e.location)}`);
    }
};

const generateExample = (defs: IEntities, entity: IChatitoEntityAST, path: number[]) => {
    const sentenceIndex = path.shift();
    const sentence = entity.inner[sentenceIndex!].sentence;
    const parts: ISentenceTokens[] = sentence.reduce(
        (acc, token) => {
            if (token.type === 'Slot' || token.type === 'Alias') {
                if (token.opt && path[0] === -1) {
                    path.shift();
                    return acc;
                }
                const innerEntity = token.type === 'Alias' ? defs.Alias : defs.Slot;
                const entityKey = token.variation ? `${token.value}#${token.variation}` : token.value;
                let tokens = generateExample(defs, innerEntity[entityKey], path);
                tokens = chatitoFormatPostProcess(tokens).map(t => {
                    if (token.type === 'Slot') {
                        if (innerEntity[entityKey].args) {
                            t.args = innerEntity[entityKey].args;
                        }
                        t.value = t.value.trim();
                        t.type = token.type;
                        t.slot = token.value;
                    }
                    return t;
                });
                return acc.concat(tokens);
            }
            return acc.concat([token]);
        },
        [] as ISentenceTokens[]
    );
    return parts;
};

const getExampleByNumber = (defs: IEntities, entity: IChatitoEntityAST, combinationNumber: number): ISentenceTokens[] => {
    let lookupNumber = combinationNumber;
    const sentenceIndex = entity.cardinalities!.findIndex(cardinality => {
        if (lookupNumber < cardinality) {
            return true;
        }
        lookupNumber -= cardinality;
        return false;
    });
    const sentence = entity.inner[sentenceIndex].sentence;
    let prevCardinality = 1;
    let prevRemaining = 0;
    const resultTokens = sentence.reduce(
        (example, token) => {
            if (token.type === 'Text') {
                return example.concat([token]);
            }
            if (token.type === 'Slot' || token.type === 'Alias') {
                let cardinality = token.opt ? 1 : 0;
                const innerEntity = token.type === 'Alias' ? defs.Alias : defs.Slot;
                const entityKey = token.variation ? `${token.value}#${token.variation}` : token.value;
                cardinality += innerEntity[entityKey].cardinality!;
                lookupNumber = (lookupNumber - prevRemaining) / prevCardinality;
                prevRemaining = lookupNumber % cardinality;
                prevCardinality = cardinality;
                if (prevRemaining === 0 && token.opt) {
                    return example;
                }
                const innerNumber = token.opt ? prevRemaining - 1 : prevRemaining;
                let tokens = getExampleByNumber(defs, innerEntity[entityKey], innerNumber);
                tokens = chatitoFormatPostProcess(tokens).map(t => {
                    if (token.type === 'Slot') {
                        if (innerEntity[entityKey].args) {
                            t.args = innerEntity[entityKey].args;
                        }
                        t.value = t.value.trim();
                        t.type = token.type;
                        t.slot = token.value;
                    }
                    return t;
                });
                return example.concat(tokens);
            }
            throw Error(`Unknown token type: ${token.type}`);
        },
        [] as ISentenceTokens[]
    );
    return chatitoFormatPostProcess(resultTokens);
};

export const getAllExamples = (defs: IEntities, entity: IChatitoEntityAST) => {
    const result: ISentenceTokens[][] = [];
    for (let i = 0; i < entity.cardinality!; i++) {
        result.push(getExampleByNumber(defs, entity, i));
    }
    return result;
};

const getExamples = (defs: IEntities, intent: IChatitoEntityAST, count: number, index: number, distribuition: 'smart' | 'even') => {
    const sentence = intent.inner[index].sentence;
    let paths: number[][] = [];
    if (distribuition === 'smart') {
        paths = getPaths(defs, sentence, index);
        if (count < paths.length) {
            utils.shuffle(paths);
            paths = paths.slice(0, count);
        }
    } else {
        // const maxCount = sentence.reduce((acc, token) => {
        //     if (token.type === 'Text') {
        //         return acc;
        //     }
        //     const entity = token.type === 'Alias' ? defs.Alias : defs.Slot;
        //     const entityKey = token.variation ? `${token.value}#${token.variation}` : token.value;
        //     return acc * entity[entityKey].paths!.length;
        // }, 1);
        // if (count > maxCount * 0.9) {
        //     paths = getPaths(defs, sentence, index);
        //     if (count < paths.length) {
        //         utils.shuffle(paths);
        //         paths = paths.slice(0, count);
        //     }
        // } else {
        paths = getRandomPaths(defs, sentence, index, count);
        // }
    }
    return paths.map(path => chatitoFormatPostProcess(generateExample(defs, intent, path)));
};

const generateExamples = (definitions: IEntities, intentKey: string, distribuition: 'smart' | 'even') => {
    const intent = definitions.Intent[intentKey];
    const maxExamplesCountBySentences = utils.maxSentences(intent, definitions);
    let targetExamplesCountBySentences = maxExamplesCountBySentences;
    let target = 0;
    if (distribuition === 'even') {
        if (intent.args && intent.args.training) {
            target = parseInt(intent.args.training, 10);
            let sentencesCount = maxExamplesCountBySentences.length;
            targetExamplesCountBySentences = maxExamplesCountBySentences.map(count => {
                const norm = Math.floor(target / sentencesCount);
                sentencesCount -= 1;
                if (count >= norm) {
                    target -= norm;
                    return norm;
                } else {
                    target -= count;
                    return count;
                }
            });
        }
    }
    let targetPerc = 100;
    if (intent.args && intent.args.training && intent.args.training.endsWith('%')) {
        targetPerc = parseFloat(intent.args.training);
        // TODO: check 0 < x <= 100
    }
    if (distribuition === 'smart' && targetPerc < 100) {
        const maxExamples = maxExamplesCountBySentences.reduce((acc, count) => acc + count, 0);
        const maxTargetExamples = Math.ceil((maxExamples * targetPerc) / 100);
        const minPerc = (targetPerc * 2) / 3;
        targetExamplesCountBySentences = maxExamplesCountBySentences.map(count => Math.floor((count * minPerc) / 100));
        // console.log('MIN BY SENTENCES:', targetExamplesCountBySentences);
        const minExamplesCount = targetExamplesCountBySentences.reduce((acc, count) => acc + count, 0);
        let remainingExamples = maxTargetExamples - minExamplesCount;
        const countsToIndexMap = maxExamplesCountBySentences.reduce(
            (acc, count, index) => {
                count in acc ? acc[count].push(index) : (acc[count] = [index]);
                return acc;
            },
            {} as { [k: number]: number[] }
        );
        const counts = Object.keys(countsToIndexMap)
            .map(k => parseInt(k, 10))
            .sort((a, b) => a - b);
        // console.log('COUNTS:', counts);
        counts.forEach(count => {
            if (!remainingExamples) {
                return;
            }
            const indices = countsToIndexMap[count];
            const avail = maxExamplesCountBySentences[indices[0]] - targetExamplesCountBySentences[indices[0]];
            const remainingPerIndex = Math.floor(remainingExamples / indices.length);
            if (remainingPerIndex >= avail) {
                indices.forEach(i => (targetExamplesCountBySentences[i] += avail));
                remainingExamples -= avail * indices.length;
            } else {
                indices.forEach(i => (targetExamplesCountBySentences[i] += remainingPerIndex));
                remainingExamples -= remainingPerIndex * indices.length;
                if (remainingExamples > 0) {
                    indices.forEach(i => {
                        if (!remainingExamples) {
                            return;
                        }
                        targetExamplesCountBySentences[i] += 1;
                        remainingExamples -= 1;
                    });
                }
            }
        });
    }
    // console.log('MAX BY SENTENCES:', maxExamplesCountBySentences);
    // console.log('TARGET BY SENTENCES:', targetExamplesCountBySentences);
    return targetExamplesCountBySentences.reduce(
        (acc, count, index) => {
            const newAcc = acc.concat(getExamples(definitions, intent, count, index, distribuition));
            return newAcc;
        },
        [] as ISentenceTokens[][]
    );
};

const getRandomPath = (defs: IEntities, entity: IChatitoEntityAST) => {
    let path = [Math.floor(Math.random() * entity.inner.length)];
    entity.inner[path[0]].sentence.forEach(token => {
        if (token.type === 'Text') {
            return;
        }
        if (token.opt && Math.random() > 0.5) {
            path.push(-1);
            return;
        }
        const innerEntity = token.type === 'Alias' ? defs.Alias : defs.Slot;
        const entityKey = token.variation ? `${token.value}#${token.variation}` : token.value;
        path = path.concat(getRandomPath(defs, innerEntity[entityKey]));
    });
    return path;
};

const getRandomPaths = (defs: IEntities, sentence: ISentenceTokens[], index: number, count: number) => {
    const paths: number[][] = [];
    const stringPaths: string[] = [];
    while (paths.length < count) {
        let currentPath: number[] = [index];
        sentence.forEach(token => {
            if (token.type === 'Text') {
                return;
            }
            if (token.opt && Math.random() > 0.5) {
                currentPath.push(-1);
                return;
            }
            const entity = token.type === 'Alias' ? defs.Alias : defs.Slot;
            const entityKey = token.variation ? `${token.value}#${token.variation}` : token.value;
            currentPath = currentPath.concat(getRandomPath(defs, entity[entityKey]));
            // const innerPaths = entity[entityKey].paths!;
            // currentPath = currentPath.concat(innerPaths[Math.floor(Math.random() * innerPaths.length)]);
        });
        if (stringPaths.some(path => path === currentPath.join())) {
            continue;
        }
        stringPaths.push(currentPath.join());
        paths.push(currentPath);
    }
    return paths;
};

const getPaths = (defs: IEntities, sentence: ISentenceTokens[], index: number) => {
    let paths = [[index]];
    sentence.forEach(token => {
        if (token.type === 'Text') {
            return;
        }
        const entity = token.type === 'Alias' ? defs.Alias : defs.Slot;
        const entityKey = token.variation ? `${token.value}#${token.variation}` : token.value;
        let optionalPaths = [] as number[][];
        if (token.opt) {
            optionalPaths = paths.map(path => path.concat([-1]));
        }
        paths = paths.reduce(
            (acc, startPath) => acc.concat(entity[entityKey].paths!.map(path => startPath.concat(path))),
            [] as number[][]
        );
        if (token.opt) {
            paths = paths.concat(optionalPaths);
        }
    });
    return paths;
};

const calcPaths = (defs: IEntities, key: string, type: 'Alias' | 'Slot') => {
    const entity = defs[type][key];
    const paths = entity.inner.reduce((acc, sentence, index) => acc.concat(getPaths(defs, sentence.sentence, index)), [] as number[][]);
    entity.paths = paths;
};

const getCardinality = (defs: IEntities, sentence: ISentenceTokens[]) => {
    return sentence.reduce((acc, token) => {
        if (token.type === 'Text') {
            return acc;
        }
        const entity = token.type === 'Alias' ? defs.Alias : defs.Slot;
        const entityKey = token.variation ? `${token.value}#${token.variation}` : token.value;

        if (token.opt) {
            return acc * (entity[entityKey].cardinality! + 1);
        }
        return acc * entity[entityKey].cardinality!;
    }, 1);
};

const calcCardinality = (defs: IEntities, key: string, type: 'Alias' | 'Slot') => {
    const entity = defs[type][key];
    const cardinalities = entity.inner.map(sentence => getCardinality(defs, sentence.sentence));
    entity.cardinality = cardinalities.reduce((acc, cardinality) => acc + cardinality, 0);
    entity.cardinalities = cardinalities;
    // console.log(`${key} cardinality:`, entity.cardinality);
};

const preCalcCardinality = (defs: IEntities) => {
    const calculated = new Set<string>();
    // cycle through uncalculated:
    let aliases = [] as string[];
    let slots = [] as string[];
    do {
        aliases = Object.keys(defs.Alias).filter(aliasKey => defs.Alias[aliasKey].cardinality === undefined);
        slots = Object.keys(defs.Slot).filter(aliasKey => defs.Slot[aliasKey].cardinality === undefined);

        aliases.forEach(aliasKey => {
            const canCalc = !defs.Alias[aliasKey].inner.find(
                sentence =>
                    !!sentence.sentence.find(token => {
                        if (token.type === 'Text') {
                            return false;
                        }
                        const entityKey = token.variation ? `${token.value}#${token.variation}` : token.value;
                        const key = (token.type === 'Alias' ? 'a' : 's') + entityKey;
                        return !calculated.has(key);
                    })
            );
            if (canCalc) {
                calcCardinality(defs, aliasKey, 'Alias');
                calculated.add(`a${aliasKey}`);
            }
        });
        slots.forEach(slotKey => {
            const canCalc = !defs.Slot[slotKey].inner.find(
                sentence =>
                    !!sentence.sentence.find(token => {
                        if (token.type === 'Text') {
                            return false;
                        }
                        const entityKey = token.variation ? `${token.value}#${token.variation}` : token.value;
                        const key = (token.type === 'Alias' ? 'a' : 's') + entityKey;
                        return !calculated.has(key);
                    })
            );
            if (canCalc) {
                calcCardinality(defs, slotKey, 'Slot');
                calculated.add(`s${slotKey}`);
            }
        });
        // console.log('entities left to count:', aliases.length + slots.length);
        // console.log('aliases left to count:', aliases);
        // console.log('slots left to count:', slots);
        // console.log('calculated', calculated);
    } while (aliases.length + slots.length > 0);
};

const preCalcPaths = (defs: IEntities) => {
    const calculated = new Set<string>();
    // cycle through uncalculated:
    let aliases = [] as string[];
    let slots = [] as string[];
    do {
        aliases = Object.keys(defs.Alias).filter(aliasKey => !defs.Alias[aliasKey].paths);
        slots = Object.keys(defs.Slot).filter(aliasKey => !defs.Slot[aliasKey].paths);

        aliases.forEach(aliasKey => {
            const canCalc = !defs.Alias[aliasKey].inner.find(
                sentence =>
                    !!sentence.sentence.find(token => {
                        if (token.type === 'Text') {
                            return false;
                        }
                        const entityKey = token.variation ? `${token.value}#${token.variation}` : token.value;
                        const key = (token.type === 'Alias' ? 'a' : 's') + entityKey;
                        return !calculated.has(key);
                    })
            );
            if (canCalc) {
                calcPaths(defs, aliasKey, 'Alias');
                calculated.add(`a${aliasKey}`);
            }
        });
        slots.forEach(slotKey => {
            const canCalc = !defs.Slot[slotKey].inner.find(
                sentence =>
                    !!sentence.sentence.find(token => {
                        if (token.type === 'Text') {
                            return false;
                        }
                        const entityKey = token.variation ? `${token.value}#${token.variation}` : token.value;
                        const key = (token.type === 'Alias' ? 'a' : 's') + entityKey;
                        return !calculated.has(key);
                    })
            );
            if (canCalc) {
                calcPaths(defs, slotKey, 'Slot');
                calculated.add(`s${slotKey}`);
            }
        });
        // console.log('entities left to count:', aliases.length + slots.length);
        // console.log('aliases left to count:', aliases);
        // console.log('slots left to count:', slots);
        // console.log('calculated', calculated);
    } while (aliases.length + slots.length > 0);
};

const addMissingAliases = (defs: IEntities) => {
    const aliases = new Set<string>();
    for (const entities of [defs.Alias, defs.Slot, defs.Intent]) {
        for (const key of Object.keys(entities)) {
            entities[key].inner.forEach(sentence => {
                sentence.sentence.forEach(token => {
                    if (token.type === 'Alias') {
                        aliases.add(token.value);
                    }
                });
            });
        }
    }
    for (const alias of aliases) {
        if (!defs.Alias[alias]) {
            defs.Alias[alias] = {
                inner: [{ sentence: [{ value: alias, type: 'Text' }], probability: null }],
                key: alias,
                type: 'AliasDefinition'
            };
        }
    }
};

export const definitionsFromAST = (initialAst: IChatitoEntityAST[], importHandler?: IFileImporter, currPath?: string) => {
    const operatorDefinitions: IEntities = { Intent: {}, Slot: {}, Alias: {} };
    if (!initialAst || !initialAst.length) {
        return;
    }
    const importer = importHandler ? importHandler : () => ({ filePath: '', dsl: '' });
    const currentPath = currPath ? currPath : '';
    // gete imports first
    let ast: IChatitoEntityAST[] = [...initialAst];
    initialAst.forEach(od => {
        if (od.type === 'ImportFile' && od.value) {
            ast = [...ast, ...getImports(currentPath, od.value, importer)];
        }
    });
    ast.forEach(od => {
        let entity: IEntityDef;
        if (od.type === 'IntentDefinition') {
            entity = operatorDefinitions.Intent;
        } else if (od.type === 'SlotDefinition') {
            entity = operatorDefinitions.Slot;
        } else if (od.type === 'AliasDefinition') {
            entity = operatorDefinitions.Alias;
        } else if (od.type === 'Comment' || od.type === 'ImportFile') {
            return; // skip comments
        } else {
            throw new Error(`Unknown definition definition for ${od.type}`);
        }
        const odKey = od.variation ? `${od.key}#${od.variation}` : od.key;
        if (entity[odKey]) {
            throw new Error(`Duplicate definition for ${od.type} '${odKey}'`);
        }
        entity[odKey] = od;
    });
    const intentKeys = Object.keys(operatorDefinitions.Intent);
    if (!intentKeys || !intentKeys.length) {
        return;
    }
    addMissingAliases(operatorDefinitions);
    // preCalcPaths(operatorDefinitions);
    // console.log('STARTED cardinality calculation');
    preCalcCardinality(operatorDefinitions);
    // console.log('FINISHED cardinality calculation');
    return operatorDefinitions;
};

export const datasetFromAST = async (
    initialAst: IChatitoEntityAST[],
    writterFn: IUtteranceWriter,
    importHandler?: IFileImporter,
    currPath?: string
) => {
    const operatorDefinitions = definitionsFromAST(initialAst, importHandler, currPath);
    if (!operatorDefinitions) {
        return;
    }
    for (const intentKey of Object.keys(operatorDefinitions.Intent)) {
        const entityArgs = operatorDefinitions.Intent[intentKey].args;
        // and for all tokens inside the sentence
        const maxPossibleCombinations = utils.maxSentencesForEntity(operatorDefinitions.Intent[intentKey], operatorDefinitions);
        let maxIntentExamples = maxPossibleCombinations; // counter that will change
        // by default if no training or testing arguments are declared, all go to training
        let trainingN = maxIntentExamples;
        let testingN = 0;
        let generatedTrainingExamplesCount = 0;
        let generatedTestingExamplesCount = 0;
        if (entityArgs) {
            if (entityArgs.training) {
                trainingN = parseInt(entityArgs.training, 10);
                if (trainingN < 1) {
                    throw new Error(`The 'training' argument for ${intentKey} must be higher than 0.`);
                }
                if (entityArgs.testing) {
                    testingN = parseInt(entityArgs.testing, 10);
                    if (testingN < 1) {
                        throw new Error(`The 'testing' argument for ${intentKey} must be higher than 0.`);
                    }
                }
            }
            const intentMax = trainingN + testingN;
            if (intentMax > maxIntentExamples) {
                throw new Error(`Can't generate ${intentMax} examples. Max possible examples is ${maxIntentExamples}`);
            } else if (intentMax < maxIntentExamples) {
                maxIntentExamples = intentMax;
            }
        }
        const maxEx = maxIntentExamples;
        const globalCache: IChatitoCache = new Map();
        const collitionsCache: { [id: string]: boolean } = {};
        let duplicatesCounter = 0;
        while (maxIntentExamples) {
            const intentSentence = await getVariationsFromEntity(
                operatorDefinitions.Intent[intentKey],
                operatorDefinitions,
                false,
                globalCache
            );
            const utterance = chatitoFormatPostProcess(intentSentence);
            const utteranceString = utterance.reduce((p, n) => p + n.value, '');
            if (!collitionsCache[utteranceString]) {
                collitionsCache[utteranceString] = true;
                const completedTraining = generatedTrainingExamplesCount >= trainingN;
                const completedTesting = generatedTestingExamplesCount >= testingN;
                let isTrainingExample = !completedTraining;
                if (!completedTraining && !completedTesting) {
                    // reference: https://stackoverflow.com/questions/44263229/generate-a-random-boolean-70-true-30-false
                    isTrainingExample = Math.random() < 0.7;
                }
                writterFn(utterance, intentKey, isTrainingExample);
                maxIntentExamples--;
                if (isTrainingExample) {
                    generatedTrainingExamplesCount++;
                } else {
                    generatedTestingExamplesCount++;
                }
            } else {
                duplicatesCounter++;
                // note: trick to make all combinations for small datasets, but avoid them for large ones
                const maxDupes = maxPossibleCombinations * maxPossibleCombinations;
                const maxDupesLimit = Math.floor(maxPossibleCombinations / 2);
                if (duplicatesCounter > (maxPossibleCombinations > 10000 ? maxDupesLimit : maxDupes)) {
                    // prevent cases where duplicates are part of the entity definitions
                    let m = `Too many duplicates while generating dataset! Looks like we have probably reached `;
                    m += `the maximun ammount of possible unique generated examples. `;
                    m += `The generator has stopped at ${maxEx - maxIntentExamples} examples for intent ${intentKey}.`;
                    // tslint:disable-next-line:no-console
                    console.warn(m);
                    maxIntentExamples = 0;
                }
            }
        }
    }
};
