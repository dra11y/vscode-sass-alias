import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs/promises'

const outputChannel = vscode.window.createOutputChannel('Sass Alias Fixer')
let extensionConfig = vscode.workspace.getConfiguration('sass-alias')
let debugMode = extensionConfig.get<boolean>('debugMode', false)
let isEnabled = extensionConfig.get<boolean>('enabled', true)
let isDevelopment = false
let provider: vscode.Disposable | undefined

function debug(msg: string) {
	if (debugMode || isDevelopment) {
		outputChannel.appendLine(msg)
	}
}

type ConfigCacheEntry = {
	aliases: Record<string, string[]>,
	lastModified: number,
	configPath: string
}

let configCache: Record<string, ConfigCacheEntry> = {}
let configPathCache: Record<string, string | null> = {}
let documentLinkCache: Record<string, vscode.DocumentLink[]> = {}

const importRegex = /@(?:use|import)\s*['"]([^'"]+)['"]/g

async function findNearestConfig(fileDir: string): Promise<string | null> {
	let currentDir = fileDir

	while (currentDir !== path.parse(currentDir).root) {
		if (configPathCache[currentDir]) {
			return configPathCache[currentDir]
		}

		debug(`Searching for tsconfig.json or jsconfig.json starting from: ${currentDir}`)

		const tsConfigPath = path.join(currentDir, 'tsconfig.json')

		if (await fileExists(tsConfigPath)) {
			debug(`Found tsconfig.json at: ${tsConfigPath}`)
			configPathCache[currentDir] = tsConfigPath
			return tsConfigPath
		}

		const jsConfigPath = path.join(currentDir, 'jsconfig.json')
		if (await fileExists(jsConfigPath)) {
			debug(`Found jsconfig.json at: ${jsConfigPath}`)
			configPathCache[currentDir] = jsConfigPath
			return jsConfigPath
		}

		configPathCache[currentDir] = null
		currentDir = path.dirname(currentDir)
	}

	debug('No tsconfig.json or jsconfig.json found in project hierarchy')
	return null
}

async function getTsConfigAliases(configPath: string): Promise<Record<string, string[]>> {
	const stat = await fs.stat(configPath)
	const lastModified = stat.mtimeMs

	const cachedConfig = configCache[configPath]
	if (cachedConfig && cachedConfig.lastModified === lastModified) {
		debug(`Using cached aliases for config: ${configPath}`)
		return cachedConfig.aliases
	}

	debug(`Parsing config file: ${configPath} (modified: ${lastModified})`)

	const configContent = await fs.readFile(configPath, 'utf-8')
	const config = JSON.parse(configContent)
	const paths = config.compilerOptions?.paths || {}

	const aliases: Record<string, string[]> = {}
	for (const alias in paths) {
		const actualPaths = paths[alias].map((p: string) => path.resolve(path.dirname(configPath), p.replace('/*', '')))
		aliases[alias.replace('/*', '')] = actualPaths
	}
	debug(`Found aliases: ${Object.keys(aliases)}`)

	configCache[configPath] = {
		aliases,
		lastModified,
		configPath
	}

	return aliases
}

async function tryWithExtensions(document: vscode.TextDocument, importPath: string): Promise<string | null> {
	const filePath = path.join(path.dirname(document.fileName), importPath)
	debug(`Trying import path with extensions: ${filePath}`)
	const extensions = ['', '.sass', '.scss', '.css']
	for (const ext of extensions) {
		const possiblePath = filePath + ext
		if (await fileExists(possiblePath)) {
			debug(`Found file with extension: ${possiblePath}`)
			return possiblePath
		}
	}
	debug(`No file found with any of the extensions: ${extensions.join(', ')}`)
	return null
}

async function resolveAlias(document: vscode.TextDocument, importPath: string, aliases: Record<string, string[]>): Promise<string | null> {
	const aliasKey = Object.keys(aliases).find(alias => importPath.startsWith(alias))

	if (!aliasKey) {
		debug(`No alias found for import: ${importPath}`)
		return await tryWithExtensions(document, importPath)
	}

	const relativePath = importPath.replace(aliasKey, '')
	const basePaths = aliases[aliasKey]

	for (const basePath of basePaths) {
		const resolvedPath = path.join(basePath, relativePath)
		if (!await fileExists(resolvedPath)) {
			debug(`Resolved path does not exist: ${resolvedPath}`)
			continue
		}

		const stat = await fs.stat(resolvedPath)
		if (stat.isFile()) {
			debug(`Resolved path exists: ${resolvedPath}`)
			return resolvedPath
		}

		if (!stat.isDirectory()) {
			debug(`Resolved path is not a file or directory: ${resolvedPath}`)
			return null
		}

		debug(`Resolved path is a directory: ${resolvedPath}`)

		// Try to find index.scss or main.scss inside the directory
		const indexPath = path.join(resolvedPath, 'index.scss')
		const mainPath = path.join(resolvedPath, 'main.scss')

		if (await fileExists(indexPath)) {
			debug(`Found index.scss at: ${indexPath}`)
			return indexPath
		}

		if (await fileExists(mainPath)) {
			debug(`Found main.scss at: ${mainPath}`)
			return mainPath
		}

		debug(`No index.scss or main.scss found in: ${resolvedPath}`)
		return null

	}

	debug(`No valid resolved path found for alias ${aliasKey}`)
	return null
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath, fs.constants.R_OK)
		return true
	} catch {
		return false
	}
}

function registerProvider(context: vscode.ExtensionContext) {
	provider = vscode.languages.registerDocumentLinkProvider(['scss', 'sass', 'css'], {
		async provideDocumentLinks(document: vscode.TextDocument): Promise<vscode.DocumentLink[]> {
			if (documentLinkCache[document.fileName]) {
				debug(`Using cached links for document: ${document.fileName}`)
				return documentLinkCache[document.fileName]
			}

			const links: vscode.DocumentLink[] = []
			const fileDir = path.dirname(document.fileName)
			const configPath = await findNearestConfig(fileDir)

			if (!configPath) return []

			const aliases = await getTsConfigAliases(configPath)
			const text = document.getText()

			let match: RegExpExecArray | null
			while ((match = importRegex.exec(text)) !== null) {
				const alias = match[1]
				const startPos = document.positionAt(match.index + match[0].indexOf(alias))
				const endPos = startPos.translate(0, alias.length)
				const range = new vscode.Range(startPos, endPos)

				const resolvedPath = await resolveAlias(document, alias, aliases)

				if (resolvedPath) {
					const resolvedUri = vscode.Uri.file(resolvedPath)
					const link = new vscode.DocumentLink(range, resolvedUri)
					links.push(link)
					debug(`Resolved link for alias: ${alias} to ${resolvedUri.toString()}`)
				}
			}

			documentLinkCache[document.fileName] = links
			return links
		}
	})

	context.subscriptions.push(provider)
}

export function activate(context: vscode.ExtensionContext) {
	extensionConfig = vscode.workspace.getConfiguration('sass-alias')
	debugMode = extensionConfig.get<boolean>('debugMode', false)
	isEnabled = extensionConfig.get<boolean>('enabled', true)
	isDevelopment = (context.extensionMode === vscode.ExtensionMode.Development)

	if (!isEnabled) {
		debug('Extension is disabled via settings.')
		return
	}

	debug('Sass Alias Fixer extension activated')

	vscode.workspace.onDidChangeTextDocument((event) => {
		if (documentLinkCache[event.document.fileName]) {
			debug(`Document edited: ${event.document.fileName}, invalidating link cache`)
			delete documentLinkCache[event.document.fileName]
		}
	})

	if (!provider) {
		registerProvider(context)
	}

	// Listen for configuration changes
	vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration('sass-alias.enabled')) {
			extensionConfig = vscode.workspace.getConfiguration('sass-alias')
			isEnabled = extensionConfig.get<boolean>('enabled', true)

			if (!isEnabled) {
				debug('Extension disabled via settings.')
				// Dispose of the provider
				if (provider) {
					provider.dispose()
					provider = undefined
				}
			} else {
				debug('Extension enabled via settings.')
				// Re-register the provider
				if (!provider) {
					registerProvider(context)
				}
			}
		}

		if (e.affectsConfiguration('sass-alias.debugMode')) {
			extensionConfig = vscode.workspace.getConfiguration('sass-alias')
			debugMode = extensionConfig.get<boolean>('debugMode', false)
			debug('Debug mode changed via settings.')
		}
	})
}

export function deactivate() {
	debug('Sass Alias Fixer extension deactivated')
}
