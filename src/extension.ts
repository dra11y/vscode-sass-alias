import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'

const outputChannel = vscode.window.createOutputChannel('Sass Alias Fixer')

type ConfigCacheEntry = {
	aliases: Record<string, string[]>,
	lastModified: number,
	configPath: string
}

let configCache: Record<string, ConfigCacheEntry> = {}

let documentLinkCache: Record<string, vscode.DocumentLink[]> = {}

// Find the nearest tsconfig.json or jsconfig.json
function findNearestConfig(fileDir: string): string | null {
	let currentDir = fileDir

	while (currentDir !== path.parse(currentDir).root) {
		// Check if the directory is already in the config cache
		if (configCache[currentDir]) {
			outputChannel.appendLine(`Using cached config for directory: ${fileDir}`)
			return configCache[currentDir].configPath
		}

		outputChannel.appendLine(`Searching for tsconfig.json or jsconfig.json starting from: ${currentDir}`)

		const tsConfigPath = path.join(currentDir, 'tsconfig.json')
		if (fs.existsSync(tsConfigPath)) {
			outputChannel.appendLine(`Found tsconfig.json at: ${tsConfigPath}`)
			return tsConfigPath
		}

		const jsConfigPath = path.join(currentDir, 'jsconfig.json')
		if (fs.existsSync(jsConfigPath)) {
			outputChannel.appendLine(`Found jsconfig.json at: ${jsConfigPath}`)
			return jsConfigPath
		}

		// Move up one directory level
		currentDir = path.dirname(currentDir)
	}

	outputChannel.appendLine('No tsconfig.json or jsconfig.json found in project hierarchy')
	return null
}

// Function to parse the nearest tsconfig.json or jsconfig.json and extract alias mappings
function getTsConfigAliases(document: vscode.TextDocument): Record<string, string[]> {
	const fileDir = path.dirname(document.fileName)
	const configPath = findNearestConfig(fileDir)

	if (!configPath) {
		outputChannel.appendLine('No tsconfig.json or jsconfig.json found')
		return {}
	}

	const stat = fs.statSync(configPath)
	const lastModified = stat.mtimeMs

	// Check if the directory is cached and if the config file has been modified
	const cachedConfig = configCache[fileDir]
	if (cachedConfig && cachedConfig.lastModified === lastModified) {
		outputChannel.appendLine(`Using cached aliases for directory: ${fileDir}`)
		return cachedConfig.aliases
	}

	outputChannel.appendLine(`Parsing config file: ${configPath} (modified: ${lastModified})`)

	const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
	const paths = config.compilerOptions?.paths || {}

	if (Object.keys(paths).length === 0) {
		outputChannel.appendLine('No paths found in tsconfig.json/jsconfig.json')
	} else {
		outputChannel.appendLine('Found paths in config.')
	}

	const aliases: Record<string, string[]> = {}
	Object.keys(paths).forEach(alias => {
		const actualPaths = paths[alias].map((p: string) => path.resolve(path.dirname(configPath), p.replace('/*', '')))
		aliases[alias.replace('/*', '')] = actualPaths
	})
	outputChannel.appendLine(`Found aliases: ${Object.keys(aliases)}`)

	// Update the cache with the new configuration, modified time, and config path
	configCache[fileDir] = {
		aliases,
		lastModified,
		configPath
	}

	return aliases
}

// Function to resolve aliases from the preloaded aliases
function resolveAlias(importPath: string, aliases: Record<string, string[]>): string | null {
	const aliasKey = Object.keys(aliases).find(alias => importPath.startsWith(alias))

	if (!aliasKey) {
		outputChannel.appendLine(`No alias found for import: ${importPath}`)
		return null
	}

	const relativePath = importPath.replace(aliasKey, '')
	const resolvedPaths = aliases[aliasKey].map(basePath => path.join(basePath, relativePath))

	outputChannel.appendLine(`Alias ${aliasKey} maps to: ${resolvedPaths}`)

	// Return the first resolved path that exists
	for (const resolvedPath of resolvedPaths) {
		if (!fs.existsSync(resolvedPath)) {
			// Fallback to default VS Code resolution
			return null
		}

		if (!fs.lstatSync(resolvedPath).isDirectory()) {
			outputChannel.appendLine(`Resolved path exists: ${resolvedPath}`)
			return resolvedPath
		}

		outputChannel.appendLine(`Resolved path is a directory: ${resolvedPath}`)

		// Try to find index.scss or main.scss inside the directory
		const indexPath = path.join(resolvedPath, 'index.scss')
		const mainPath = path.join(resolvedPath, 'main.scss')

		if (fs.existsSync(indexPath)) {
			outputChannel.appendLine(`Found index.scss at: ${indexPath}`)
			return indexPath
		} else if (fs.existsSync(mainPath)) {
			outputChannel.appendLine(`Found main.scss at: ${mainPath}`)
			return mainPath
		} else {
			outputChannel.appendLine(`No index.scss or main.scss found in: ${resolvedPath}`)
			return null
		}
	}
	outputChannel.appendLine(`No valid resolved path found for alias ${aliasKey}`)

	return null
}

// This function gets called when the extension is activated
export function activate(context: vscode.ExtensionContext) {
	outputChannel.appendLine('Sass/SCSS/CSS Import Alias Link Fixer extension activated')

	// Register a listener for document changes to invalidate cache
	vscode.workspace.onDidChangeTextDocument((event) => {
		if (documentLinkCache[event.document.fileName]) {
			outputChannel.appendLine(`Document edited: ${event.document.fileName}, invalidating link cache`)
			delete documentLinkCache[event.document.fileName]
		}
	})

	// Register a DocumentLinkProvider for .scss, .sass, and .css files
	context.subscriptions.push(
		vscode.languages.registerDocumentLinkProvider(['scss', 'sass', 'css'], {
			provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
				// Return cached links if available
				if (documentLinkCache[document.fileName]) {
					outputChannel.appendLine(`Using cached links for document: ${document.fileName}`)
					return documentLinkCache[document.fileName]
				}

				// Generate new links if not cached
				const links: vscode.DocumentLink[] = []
				const aliases = getTsConfigAliases(document) // Load the aliases as usual
				const text = document.getText()

				// Regex to match @use or @import statements in SCSS/SASS
				const regex = /@(?:use|import)\s*['"]([^'"]+)['"]/g
				let match: RegExpExecArray | null

				while ((match = regex.exec(text)) !== null) {
					const alias = match[1]
					const startPos = document.positionAt(match.index + match[0].indexOf(alias))
					const endPos = startPos.translate(0, alias.length)
					const range = new vscode.Range(startPos, endPos)

					// Resolve the alias using the preloaded aliases
					const resolvedPath = resolveAlias(alias, aliases)

					if (resolvedPath && fs.existsSync(resolvedPath)) {
						const resolvedUri = vscode.Uri.file(resolvedPath)
						const link = new vscode.DocumentLink(range, resolvedUri)
						links.push(link)
						outputChannel.appendLine(`Resolved link for alias: ${alias} to ${resolvedUri.toString()}`)
					}
				}

				// Cache the generated links for future use
				documentLinkCache[document.fileName] = links

				return links
			}
		})
	)
}

// This function gets called when the extension is deactivated
export function deactivate() {
	outputChannel.appendLine('Sass/SCSS/CSS Import Alias Link Fixer extension deactivated')
}
