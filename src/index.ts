#!/usr/bin/env node

/**
 * pin-lerna-package-versions
 * Pin lerna dependencies to latest managed version
 */

import * as fs from 'fs'
import * as path from 'path'
import * as t from 'io-ts'
import Debug from 'debug'
import execa from 'execa'
import deepEqual from 'fast-deep-equal'
import Future from 'fluture'
import { FutureInstance, encaseN2, parallel, fork, reject, of as resolve } from 'fluture'
import { docopt } from 'docopt'
import { mod } from 'shades'
import { pipe } from 'fp-ts/lib/pipeable'
import { Option, none, some } from 'fp-ts/lib/Option'
import { Either, fromOption, either, map, chain, fold, parseJSON, tryCatch, toError } from 'fp-ts/lib/Either'

const debug = {
    cmd: Debug('pin'),
    options: Debug('pin:options')
}

const docstring = `
Usage:
    pin-lerna-package-versions <root>

Options:
    root:    Root of lerna mono-repository
`

type CoreReadFile = (
    path: fs.PathLike,
    options: string,
    callback: (err: NodeJS.ErrnoException | null, data: string) => void
) => void;

const readFile = encaseN2(fs.readFile as CoreReadFile)
const writeFile = encaseN2(fs.writeFile)

function prettyStringifyJson<E>(
    u: unknown,
    onError: (reason: unknown) => E
): Either<E, string> {
    return tryCatch(() => JSON.stringify(u, null, 4), onError)
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function trace(
    logger: typeof console.log,
    ...tag: any[]
): <T>(value: T) => T {
    return function trace<T>(value: T): T {
        if (tag.length > 0) {
            logger(...tag, value)
        } else {
            logger(value)
        }
        return value
    }
}

export const StringifiedJSON = <C extends t.Mixed>(codec: C) =>
    new t.Type<t.TypeOf<C>, string, unknown>(
        `StringifiedJSON`.concat(codec.name),
        (u): u is C => typeof u !== 'string'
            ? false
            : pipe(
                parseJSON(u, toError),
                fold(
                    () => false,
                    codec.is
                )
            ),
        (u, c) => either.chain(
            t.string.validate(u, c),
            string => pipe(
                parseJSON(string, toError),
                fold(
                    () => t.failure(u, c),
                    codec.decode
                )
            )
        ),
        codec.encode
    )

const CommandLineOptions = t.type({
    '<root>': t.string
})
type CommandLineOptions = t.TypeOf<typeof CommandLineOptions>;

const PackageJsonRequired = t.type({
    name: t.string,
    version: t.string,
})

const PackageJsonOptional = t.partial({
    dependencies: t.record(t.string, t.string),
    devDependencies: t.record(t.string, t.string),
})

const PackageJson = t.intersection([PackageJsonRequired, PackageJsonOptional])
type PackageJson = t.TypeOf<typeof PackageJson>;

const LernaPackage = t.type({
    name: t.string,
    version: t.string,
    location: t.string,
    private: t.boolean
})
type LernaPackage = t.TypeOf<typeof LernaPackage>;

type Package = string;
type VersionString = string;

function lernaPackages(
    {'<root>': root}: {'<root>': string}
): FutureInstance<unknown, LernaPackage[]> {
    return Future((reject, resolve) => {

        const subcommand = execa.command(
            'npx lerna list --all --json',
            {cwd: root}
        )

        subcommand
            .then(({stdout}) => pipe(
                stdout,
                StringifiedJSON(t.array(LernaPackage)).decode,
                fold(reject, resolve)
            ))
            .catch(reject)

        return function onCancel() {
            subcommand.cancel()
        }
    })
}

function packageDictionary(
    packages: LernaPackage[]
): Record<Package, VersionString> {
    return packages.reduce(
        (acc, {name, version}) => Object.assign(acc, {[name]: `^${version}`}),
        {} as Record<Package, VersionString>
    )
}

function updateDependencies(
    dependencies: Record<Package, VersionString>
): (packageJson: string) => FutureInstance<unknown, unknown> {
    return function updateDependenciesFor(packageJson) {

        const withLatestDependencies = (
            deps: Record<Package, VersionString> | undefined
        ): Record<Package, VersionString> =>
            Object.entries(deps || {}).reduce(
            (acc, [pkg, version]) => Object.assign(
                acc,
                {[pkg]: dependencies[pkg] || version}
            ),
            {} as Record<Package, VersionString>
        )

        return readFile(packageJson, 'utf8')
            .chain((string): FutureInstance<Error, Option<PackageJson>> => pipe(
                StringifiedJSON(PackageJson).decode(string),
                map(originalJson => pipe(
                    originalJson,
                    mod ('dependencies') (withLatestDependencies),
                    mod ('devDependencies') (withLatestDependencies),
                    updatedJson => deepEqual(originalJson, updatedJson)
                        ? none
                        : some(updatedJson)
                )),
                fold(
                    () => reject(new Error(`Could not parse JSON from '${packageJson}'`)),
                    (updates) => resolve(updates)
                )
            ))
            .chain(updates => pipe(
                updates,
                fromOption(() => null),
                map(trace(debug.cmd, 'Updating file', packageJson)),
                chain(updates => prettyStringifyJson(updates, toError as (e: unknown) => Error | null)),
                fold(
                    error => error === null ? resolve(undefined) : reject(error),
                    string => writeFile(packageJson, string)
                )
            ))
    }
}

function main(): void {
    pipe(
        process.argv.slice(2),
        argv => docopt(docstring, {argv, help: true, exit: true}),
        CommandLineOptions.decode,
        map(trace(debug.options, 'Options')),
        map(options => lernaPackages(options)
            .chain(packages => {
                const dictionary = packageDictionary(packages)

                const packageJsons = packages
                    .map(pkg => pkg.location)
                    .map(dir => path.resolve(dir, 'package.json'))

                return parallel(
                    Infinity,
                    packageJsons.map(updateDependencies(dictionary))
                )
            })
           ),
        fold(
            console.error.bind(null),
            fork(
                console.error.bind(null),
                () => {}
            )
        )
    )
}

main()

//  LocalWords:  packageJson devDependencies

// Local Variables:
// mode: typescript
// End:
