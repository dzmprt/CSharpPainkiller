import * as vscode from 'vscode';
import * as pathModule from 'path';
import { AsyncCache, waitWithCancellation, throwIfCancelled } from '../utils/asyncWork.js';
import { runDotnet } from '../utils/dotnetCli.js';
import { CsprojCache } from '../utils/csprojCache.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DotnetTemplate {
  name: string;
  shorthand: string;
  language: string[];
  tags: string[];
  classId: string; // csharppainkiller.dotnet.create.<shorthand>
  menuOrder: number; // order within submenu
}

interface DotnetCreateProjectTarget {
  physicalBaseUri: vscode.Uri;
  solutionUri?: vscode.Uri;
  solutionFolderPath?: string;
}

// ---------------------------------------------------------------------------
// Parsing: run `dotnet new list` and parse the text table output
// ---------------------------------------------------------------------------

export function parseDotnetTemplateList(output: string): Array<{ name: string; shorthand: string; language: string; tags: string }> {
    output = output.replace(/^\r?\n/, '');
    const lines = output.split(/\r?\n/).filter(line => line.trim() !== '');

    // Skip header lines (lines starting with "Template", "--------------------------------", etc.)
    const dataLines: string[] = [];
    let startedData = false;

    for (const line of lines) {
      // Detect header end: a line made of dashes/underscores
      if (/^[\s\-_=]+$/m.test(line.trim()) && line.trim().length > 10) {
        startedData = true;
        continue;
      }
      // Detect column header line (contains "Template Name", "Short Name", etc.)
      if (/Template\s+Name/.test(line)) {
        continue;
      }

      if (startedData) {
        dataLines.push(line);
      }
    }

    // Parse each data line — columns are separated by multiple spaces
    const templates: Array<{ name: string; shorthand: string; language: string; tags: string }> = [];

    for (const line of dataLines) {
      // Split by 2+ spaces to get columns
      const parts = line.split(/\s{2,}/).filter(p => p.trim() !== '');
      if (parts.length < 3) { throw new Error(`Cannot parse .NET template row: ${line.trim()}`); }

      const name = parts[0].trim();
      const shorthand = parts[1].trim();

      // File templates (e.g., dotnet gitignore file) have no language column:
      //   "dotnet gitignore file  gitignore,.gitignore            Config" => 3 parts
      // Project templates have language:
      //   "Console App              console                             [C#],F#,VB  Common/Console" => 4+ parts
      // Detect if part[2] looks like a language column (starts with [ or contains comma-separated languages)
      let language = '';
      let tags = '';
      if (parts.length === 3) {
        // No language column - this is a file/template config entry
        tags = parts[2].trim();
      } else {
        // 4+ parts: name, shorthand, language, tags...
        const potentialLanguage = parts[2].trim();
        // Check if it looks like a language specifier (e.g., "[C#]", "[C#],F#", "[Python]")
        if (potentialLanguage.startsWith('[')) {
          language = potentialLanguage;
          tags = parts.slice(3).join(' ').trim();
        } else {
          // No language column (3+ parts where part[2] isn't a language)
          tags = potentialLanguage;
        }
      }

      if (name && shorthand) {
        templates.push({ name, shorthand, language, tags });
      }
    }

    if (!startedData) { throw new Error('dotnet new list did not return a template table.'); }
    return templates;
}

// ---------------------------------------------------------------------------
// Helper: determine if a file/config template is relevant for C# development
// ---------------------------------------------------------------------------

function isRelevantFileTemplate(shorthand: string, tagsLower: string): boolean {
  // Common file templates that are useful for C# development regardless of language column
  const relevantShorthands = new Set([
    'gitignore', '.gitignore', 'gitattributes', 
    'editorconfig', '.editorconfig',
    'globaljson', 'global.json',
    'nugetconfig', 'nuget.config', 'webconfig',
    'webconfig',
    'proto',
    'sln', 'solution',
    'tool-manifest',
    // File templates for ASP.NET Core (these generate .cs files)
    'page', 'view', 'razorcomponent', 'viewimports', 'viewstart',
    'apicontroller', 'mvccontroller',
  ]);

  if (getTemplateShorthandAliases(shorthand).some(alias => relevantShorthands.has(alias))) {
    return true;
  }

  // Include templates tagged as Web/ASP.NET (these generate C# files)
  if (tagsLower.includes('web/') || tagsLower.includes('asp.net')) {
    return true;
  }

  // Include Config-tagged templates (common config files for .NET projects)
  if (tagsLower === 'config') {
    return true;
  }

  // Include MSBuild templates
  if (tagsLower.includes('msbuild')) {
    return true;
  }

  // Include Solution templates
  if (tagsLower.includes('solution')) {
    return true;
  }

  // Include gRPC templates
  if (tagsLower.includes('grpc')) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Main: fetch and build template menu structure
// ---------------------------------------------------------------------------

const sdkCache = new AsyncCache<string, string>(20, 30_000);
const templateCache = new AsyncCache<string, DotnetTemplate[]>(20, 5 * 60_000);

export async function fetchDotnetTemplates(
  _context: Pick<vscode.ExtensionContext, 'subscriptions'>,
  cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
  token?: vscode.CancellationToken,
): Promise<DotnetTemplate[]> {
  throwIfCancelled(token);
  const sdk = await waitWithCancellation(sdkCache.get(cwd, async () =>
    (await runDotnet(['--version'], cwd, undefined, 30_000)).stdout.trim()
  ), token);
  return waitWithCancellation(templateCache.get(`${cwd}::${sdk}`, async () => {
  const listed = await runDotnet(['new', 'list'], cwd, undefined, 30_000);
  const rawTemplates = parseDotnetTemplateList(listed.stdout);

  const result: DotnetTemplate[] = [];

  for (const raw of rawTemplates) {
    // File templates have no language column (empty string). Include them if they're relevant for C# development.
    // File templates are identified by having an empty language string.
    const hasLanguage = raw.language.trim().length > 0;

    if (hasLanguage) {
      // Skip non-C# templates for now (we can extend later)
      if (!raw.language.includes('C#')) {
        continue;
      }
    } else {
      // File/config templates without language - include common ones useful for C# development
      const lowerTags = raw.tags.toLowerCase();
      // Skip templates that are clearly not C# related (e.g., Python configs)
      if (!isRelevantFileTemplate(raw.shorthand, lowerTags)) {
        continue;
      }
    }

    // Clean up the template name for display (remove trailing ellipsis, clean up)
    const displayName = raw.name.replace(/\.\.\.$/, '…').trim();

    // Create a safe classId from shorthand
    const safeShorthand = raw.shorthand.replace(/[^a-zA-Z0-9]/g, '');

    result.push({
      name: displayName,
      shorthand: raw.shorthand,
      language: hasLanguage ? raw.language.split(',').map(l => l.trim()).filter(Boolean) : [],
      tags: raw.tags.split('/').map(t => t.trim()).filter(Boolean),
      classId: `csharppainkiller.dotnet.create.${safeShorthand}`,
      menuOrder: 0, // will be set below
    });
  }

  return result;
  }), token);
}

// ---------------------------------------------------------------------------
// Dynamic command registration: registers commands and submenu entries
// ---------------------------------------------------------------------------

export interface TemplateMenuEntry {
  template: DotnetTemplate;
  commandDisposable: vscode.Disposable;
}

export function registerDynamicTemplateCommands(templates: DotnetTemplate[], context: Pick<vscode.ExtensionContext, 'subscriptions'>, registerUnified = true): TemplateMenuEntry[] {
  const entries: TemplateMenuEntry[] = [];
  const uniqueTemplates: DotnetTemplate[] = [];
  const shorthands = new Set<string>();
  const commandIds = new Set<string>();
  const reservedIds = new Set(templates.map(template => template.classId));

  for (const template of templates) {
    // CLI rows can share a short name; creation uses only the primary alias.
    const shorthand = getPrimaryTemplateShorthand(template.shorthand);
    if (shorthands.has(shorthand)) {
      continue;
    }
    shorthands.add(shorthand);

    let classId = template.classId;
    if (commandIds.has(classId)) {
      let suffix = 1;
      do {
        classId = `${template.classId}_${suffix++}`;
      } while (reservedIds.has(classId) || commandIds.has(classId));
    }
    commandIds.add(classId);
    const commandTemplate = { ...template, classId };
    uniqueTemplates.push(commandTemplate);

    const disposable = vscode.commands.registerCommand(
      commandTemplate.classId,
      async () => {
        await createProjectByTemplate(commandTemplate);
      }
    );

    context.subscriptions.push(disposable);
    entries.push({ template: commandTemplate, commandDisposable: disposable });
  }

  // Register the unified "Create .NET Project" command that shows grouped templates
  if (registerUnified) { registerUnifiedCreateProjectCommand(async () => uniqueTemplates, context); }

  return entries;
}

// ---------------------------------------------------------------------------
// Unified "Create .NET Project" command with grouped QuickPick
// ---------------------------------------------------------------------------

export function registerLazyTemplateCommands(context: Pick<vscode.ExtensionContext, 'subscriptions'>): void {
  let currentTemplates: DotnetTemplate[] | undefined;
  let entries: TemplateMenuEntry[] = [];
  registerUnifiedCreateProjectCommand(async target => {
    const uri = target instanceof vscode.Uri ? target : target?.physicalBaseUri;
    const base = uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!base) { throw new Error('Open a workspace folder to list .NET templates.'); }
    let cwd = base.fsPath;
    try {
      if ((await vscode.workspace.fs.stat(base)).type === vscode.FileType.File) { cwd = pathModule.dirname(cwd); }
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') { throw error; }
      cwd = vscode.workspace.getWorkspaceFolder(base)?.uri.fsPath ?? cwd;
    }
    const templates = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification, title: 'Loading .NET templates', cancellable: true,
    }, (_progress, token) => fetchDotnetTemplates(context, cwd, token));
    if (templates !== currentTemplates) {
      for (const entry of entries) { entry.commandDisposable.dispose(); }
      entries = registerDynamicTemplateCommands(templates, context, false);
      currentTemplates = templates;
    }
    return entries.map(entry => entry.template);
  }, context);
  const watcher = vscode.workspace.createFileSystemWatcher('**/global.json');
  const clear = () => { sdkCache.clear(); templateCache.clear(); };
  context.subscriptions.push(watcher, watcher.onDidCreate(clear), watcher.onDidChange(clear), watcher.onDidDelete(clear),
    { dispose: clear });
}

function registerUnifiedCreateProjectCommand(
  load: (target?: vscode.Uri | DotnetCreateProjectTarget) => Promise<DotnetTemplate[]>,
  context: Pick<vscode.ExtensionContext, 'subscriptions'>,
): void {
  const disposable = vscode.commands.registerCommand(
    'csharppainkiller.dotnet.createProject',
    async (target?: vscode.Uri | DotnetCreateProjectTarget) => {
      let templates: DotnetTemplate[];
      try {
        templates = await load(target);
      } catch (error) {
        if (error instanceof vscode.CancellationError) { return; }
        console.error('Loading .NET templates failed:', error);
        vscode.window.showErrorMessage(`Failed to list .NET templates: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      // Sort templates by shorthand for consistent ordering
      const sortedTemplates = [...templates].sort((a, b) => a.shorthand.localeCompare(b.shorthand));

      // Build flat QuickPick list
      const picks: vscode.QuickPickItem[] = sortedTemplates.map(t => ({
        label: `$(file-code) ${t.name}`,
        description: t.shorthand,
        detail: `dotnet new ${getPrimaryTemplateShorthand(t.shorthand)}`,
      }));

      const pick = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Select a .NET template to create',
        canPickMany: false,
      });

      if (pick) {
        const template = sortedTemplates.find(t => t.shorthand === pick.description);
        if (template) {
          await createProjectByTemplate(template, target);
        }
      }
    }
  );

  context.subscriptions.push(disposable);
}

// ---------------------------------------------------------------------------
// Dynamic submenu registration (at runtime via setContext + menu manipulation)
// ---------------------------------------------------------------------------

export interface SubmenuDefinition {
  id: string;
  label: string;
  order: number;
}

// ---------------------------------------------------------------------------
// Project creation handler for dynamic templates
// ---------------------------------------------------------------------------

async function createProjectByTemplate(template: DotnetTemplate, selectedTarget?: vscode.Uri | DotnetCreateProjectTarget): Promise<void> {
  // Use the URI from explorer selection (folder), or fall back to workspace root
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('CSharp Painkiller: No workspace folder open. Open a folder to create a project.');
    return;
  }

  // If user right-clicked a folder in explorer, use that folder as the base
  let baseFolderUri: vscode.Uri;
  const projectTarget = isDotnetCreateProjectTarget(selectedTarget) ? selectedTarget : undefined;
  const selectedUri = selectedTarget instanceof vscode.Uri ? selectedTarget : projectTarget?.physicalBaseUri;
  if (selectedUri) {
    // Check if it's a folder or file URI
    try {
      const statType = await vscode.workspace.fs.stat(selectedUri);
      if (statType.type === vscode.FileType.Directory) {
        baseFolderUri = selectedUri;
      } else {
        // It's a file, use its parent directory
        baseFolderUri = vscode.Uri.file(pathModule.dirname(selectedUri.fsPath));
      }
    } catch {
      // URI doesn't exist yet, use workspace root
      baseFolderUri = workspaceFolders[0].uri;
    }
  } else {
    baseFolderUri = workspaceFolders[0].uri;
  }

  if (await isInsideExistingProject(baseFolderUri)) {
    vscode.window.showErrorMessage('CSharp Painkiller: Create projects only in the workspace root or regular folders, not inside an existing project.');
    return;
  }

  const projectName = await vscode.window.showInputBox({
    prompt: `Enter ${template.name} project name`,
    placeHolder: `My${template.name}`,
    validateInput: (value) => {
      if (!value || value.trim() === '') {
        return 'Project name is required';
      }
      return null;
    },
  });

  if (!projectName) {
    return;
  }

  const projectFolderPath = vscode.Uri.file(pathModule.join(baseFolderUri.fsPath, projectName));
  const projectFilePath = vscode.Uri.file(pathModule.join(projectFolderPath.fsPath, `${projectName}.csproj`));

  // Search for solution near baseFolderUri unless Solution Structure passed an explicit solution.
  const solution = projectTarget?.solutionUri ?? await findSolutionFileNear(baseFolderUri);

  try {
    // Ensure parent directory exists
    await ensureDirectoryExists(pathModule.dirname(projectFolderPath.fsPath));

    // Build and run dotnet new command
    const newArgs = ['new', getPrimaryTemplateShorthand(template.shorthand), '-o', projectFolderPath.fsPath, '--name', projectName];

    if (solution) {
      const slnDir = pathModule.dirname(solution.fsPath);
      await runDotnetCommand(newArgs, slnDir);

      let addedToSolution = false;
      // Only project templates create .csproj files that can be added to a solution.
      if (await fileExists(projectFilePath)) {
        addedToSolution = await addProjectToSolution(solution, projectFolderPath, projectName, slnDir, projectTarget?.solutionFolderPath);
      }

      vscode.window.showInformationMessage(
        addedToSolution
          ? `Created ${template.name} project "${projectName}" and added to solution.`
          : `Created ${template.name} "${projectName}".`
      );
    } else {
      await runDotnetCommand(newArgs, pathModule.dirname(projectFolderPath.fsPath));
      vscode.window.showInformationMessage(`Created ${template.name} project "${projectName}".`);
    }
  } catch (error) {
    if (error instanceof vscode.CancellationError) { return; }
    vscode.window.showErrorMessage(`Failed to create ${template.name} project: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function getPrimaryTemplateShorthand(shorthand: string): string {
  return getTemplateShorthandAliases(shorthand)[0] ?? shorthand.trim();
}

function getTemplateShorthandAliases(shorthand: string): string[] {
  return shorthand
    .split(',')
    .map(alias => alias.trim())
    .filter(Boolean);
}

function isDotnetCreateProjectTarget(value: unknown): value is DotnetCreateProjectTarget {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<DotnetCreateProjectTarget>;
  return candidate.physicalBaseUri instanceof vscode.Uri &&
    (candidate.solutionUri === undefined || candidate.solutionUri instanceof vscode.Uri) &&
    (candidate.solutionFolderPath === undefined || typeof candidate.solutionFolderPath === 'string');
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return stat.type === vscode.FileType.File;
  } catch {
    return false;
  }
}

async function isInsideExistingProject(folderUri: vscode.Uri): Promise<boolean> {
  const csprojFiles = await CsprojCache.getInstance().getProjectUris();
  const selectedPath = pathModule.normalize(folderUri.fsPath);

  return csprojFiles.some(csprojUri => {
    const projectDir = pathModule.normalize(pathModule.dirname(csprojUri.fsPath));
    return selectedPath === projectDir || selectedPath.startsWith(projectDir + pathModule.sep);
  });
}

// ---------------------------------------------------------------------------
// Helper: find solution file near URI (copied from dotnetCommands.ts)
// ---------------------------------------------------------------------------

async function findSolutionFileNear(uri: vscode.Uri): Promise<vscode.Uri | null> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    return null;
  }

  const workspaceRootPath = workspaceFolders[0].uri.fsPath;
  let currentDir = uri.fsPath;

  try {
    const statType = await vscode.workspace.fs.stat(vscode.Uri.file(currentDir));
    if (statType.type === vscode.FileType.File) {
      currentDir = pathModule.dirname(currentDir);
    }
  } catch {
    // Directory doesn't exist yet
  }

  while (true) {
    try {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(currentDir));
      for (const [name] of entries) {
        if (name.endsWith('.slnx') || name.endsWith('.sln')) {
          return vscode.Uri.file(pathModule.join(currentDir, name));
        }
      }
    } catch {
      // Ignore errors
    }

    if (currentDir === workspaceRootPath || currentDir === pathModule.parse(currentDir).root) {
      break;
    }
    currentDir = pathModule.dirname(currentDir);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helper: run dotnet command (simplified version from dotnetCommands.ts)
// ---------------------------------------------------------------------------

async function runDotnetCommand(args: string[], cwd: string): Promise<void> {
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification, title: `dotnet ${args.slice(0, 2).join(' ')}`, cancellable: true,
  }, async (_progress, token) => { await runDotnet(args, cwd, token); });
}

// ---------------------------------------------------------------------------
// Helper: ensure directory exists
// ---------------------------------------------------------------------------

async function ensureDirectoryExists(dirPath: string): Promise<void> {
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirPath));
}

// ---------------------------------------------------------------------------
// Helper: add project to solution (simplified from dotnetCommands.ts)
// ---------------------------------------------------------------------------

async function addProjectToSolution(solutionUri: vscode.Uri, projectFolderUri: vscode.Uri, projectName: string, slnDir: string, solutionFolderPath?: string): Promise<boolean> {
  try {
    const projectFilePath = pathModule.join(projectFolderUri.fsPath, `${projectName}.csproj`);
    if (solutionUri.path.endsWith('.slnx')) {
      await addProjectToSlnx(solutionUri, projectFilePath, slnDir, solutionFolderPath);
    } else {
      await runDotnetCommand(['sln', solutionUri.fsPath, 'add', projectFilePath], slnDir);
      if (solutionFolderPath) {
        const content = await readUtf8(solutionUri);
        const relativeProjectPath = pathModule.relative(slnDir, projectFilePath).replace(/\\/g, '/');
        const updated = moveSlnProjectToFolder(content, relativeProjectPath, solutionFolderPath);
        if (updated !== content) {
          await vscode.workspace.fs.writeFile(solutionUri, Buffer.from(updated, 'utf-8'));
        }
      }
    }
    return true;
  } catch (error) {
    if (error instanceof vscode.CancellationError) { throw error; }
    console.error('Failed to add project to solution:', error);
    vscode.window.showWarningMessage(`Project was created but could not be added to the solution: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function addProjectToSlnx(solutionUri: vscode.Uri, projectFilePath: string, slnDir: string, solutionFolderPath?: string): Promise<void> {
  const bytes = await vscode.workspace.fs.readFile(solutionUri);
  const content = Buffer.from(bytes).toString('utf-8');
  const relativeProjectPath = pathModule.relative(slnDir, projectFilePath).replace(/\\/g, '/');

  if (content.includes(`Path="${relativeProjectPath}"`)) {
    return;
  }

  const projectXml = `  <Project Path="${escapeXml(relativeProjectPath)}" />\n`;
  const updated = insertSlnxProject(content, relativeProjectPath, projectXml, solutionFolderPath);
  await vscode.workspace.fs.writeFile(solutionUri, Buffer.from(updated, 'utf-8'));
}

function insertSlnxProject(content: string, relativeProjectPath: string, projectXml: string, solutionFolderPath?: string): string {
  const projectDir = normaliseSlnxPath(solutionFolderPath ?? pathModule.dirname(relativeProjectPath));
  const folderMatches = findSlnxFolderStarts(content)
    .filter(match => isProjectUnderSlnxFolder(projectDir, match.value))
    .sort((a, b) => b.value.length - a.value.length);

  for (const match of folderMatches) {
    const inserted = insertXmlIntoSlnxFolder(content, match, projectXml);
    if (inserted !== content) {
      return inserted;
    }
  }

  const solutionCloseIndex = content.lastIndexOf('</Solution>');
  if (solutionCloseIndex >= 0) {
    return `${content.slice(0, solutionCloseIndex)}${projectXml}${content.slice(solutionCloseIndex)}`;
  }

  return `${content.trimEnd()}\n${projectXml}`;
}

function findSlnxFolderStarts(content: string): Array<{ index: number; end: number; value: string; isSelfClosing: boolean }> {
  const folders: Array<{ index: number; end: number; value: string; isSelfClosing: boolean }> = [];
  const folderStack: string[] = [];
  const tagRegex = /<\s*(\/?)\s*Folder\b([^>]*?)(\/?)>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(content)) !== null) {
    const isClosing = match[1] === '/';
    const attrs = parseAttributes(match[2]);
    const isSelfClosing = match[3] === '/' || /\/\s*$/.test(match[2]);

    if (isClosing) {
      folderStack.pop();
      continue;
    }

    const folderName = attrs.get('Path') ?? attrs.get('Name');
    if (!folderName) {
      continue;
    }

    const folderPath = normaliseSlnxPath(attrs.has('Path') ? folderName : [...folderStack, folderName].join('/'));
    folders.push({
      index: match.index,
      end: match.index + match[0].length,
      value: folderPath,
      isSelfClosing,
    });

    if (!isSelfClosing) {
      folderStack.push(folderPath);
    }
  }

  return folders;
}

function insertXmlIntoSlnxFolder(content: string, folderStart: { index: number; end: number; isSelfClosing: boolean }, xml: string): string {
  const indent = getLineIndent(content, folderStart.index);
  const childIndent = `${indent}  `;
  const indentedXml = xml.replace(/^  /, childIndent);

  if (folderStart.isSelfClosing) {
    const openTag = content.slice(folderStart.index, folderStart.end).replace(/\s*\/>$/, '>');
    const replacement = `${openTag}\n${indentedXml}${indent}</Folder>`;
    return `${content.slice(0, folderStart.index)}${replacement}${content.slice(folderStart.end)}`;
  }

  const closeIndex = findClosingFolderIndex(content, folderStart.index);
  if (closeIndex < 0) {
    return content;
  }

  return `${content.slice(0, closeIndex)}${indentedXml}${content.slice(closeIndex)}`;
}

function findClosingFolderIndex(content: string, openIndex: number): number {
  const tagRegex = /<\s*(\/?)\s*Folder\b[^>]*(\/?)>/gi;
  tagRegex.lastIndex = openIndex;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(content)) !== null) {
    const isClosing = match[1] === '/';
    const isSelfClosing = match[2] === '/';
    if (!isClosing && !isSelfClosing) {
      depth++;
    } else if (isClosing) {
      depth--;
      if (depth === 0) {
        return match.index;
      }
    }
  }
  return -1;
}

function parseAttributes(input: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const attrRegex = /(\w+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(input)) !== null) {
    attrs.set(match[1], match[2]);
  }
  return attrs;
}

function getLineIndent(content: string, index: number): string {
  const lineStart = content.lastIndexOf('\n', index - 1) + 1;
  const linePrefix = content.slice(lineStart, index);
  return linePrefix.match(/^\s*/)?.[0] ?? '';
}

function moveSlnProjectToFolder(content: string, projectPath: string, solutionFolderPath: string): string {
  const normalizedProjectPath = normaliseSlnxPath(projectPath);
  const normalizedFolderPath = normaliseSlnxPath(solutionFolderPath);
  const projectGuid = findSlnProjectGuidByPath(content, normalizedProjectPath);
  const folderGuid = findSlnFolderGuidByPath(content, normalizedFolderPath);
  if (!projectGuid || !folderGuid) {
    return content;
  }

  return upsertSlnNestedProject(content, projectGuid, folderGuid);
}

function findSlnProjectGuidByPath(content: string, normalizedProjectPath: string): string | undefined {
  const projectRegex = /^Project\("\{[^}]+\}"\)\s*=\s*"[^"]+",\s*"([^"]+)",\s*"\{([^}]+)\}"/gm;
  let match: RegExpExecArray | null;
  while ((match = projectRegex.exec(content)) !== null) {
    if (normaliseSlnxPath(match[1]) === normalizedProjectPath) {
      return match[2].toUpperCase();
    }
  }
  return undefined;
}

function findSlnFolderGuidByPath(content: string, normalizedFolderPath: string): string | undefined {
  const solutionFolderTypeGuid = '2150e333-8fdc-42a3-9474-1a3956d46de8';
  const entries = new Map<string, { name: string; parentGuid?: string; isFolder: boolean }>();
  const projectRegex = /^Project\("\{([^}]+)\}"\)\s*=\s*"([^"]+)",\s*"[^"]+",\s*"\{([^}]+)\}"/gm;
  let match: RegExpExecArray | null;
  while ((match = projectRegex.exec(content)) !== null) {
    entries.set(match[3].toUpperCase(), {
      name: match[2],
      isFolder: match[1].toLowerCase() === solutionFolderTypeGuid,
    });
  }

  const nestedMatch = content.match(/GlobalSection\(NestedProjects\)\s*=\s*preSolution[\s\S]*?EndGlobalSection/);
  if (nestedMatch) {
    const nestedRegex = /\{([^}]+)\}\s*=\s*\{([^}]+)\}/g;
    let nested: RegExpExecArray | null;
    while ((nested = nestedRegex.exec(nestedMatch[0])) !== null) {
      entries.get(nested[1].toUpperCase())!.parentGuid = nested[2].toUpperCase();
    }
  }

  for (const [guid, entry] of entries) {
    if (!entry.isFolder) {
      continue;
    }
    const segments = [entry.name];
    let parentGuid = entry.parentGuid;
    while (parentGuid) {
      const parent = entries.get(parentGuid);
      if (!parent) {
        break;
      }
      segments.unshift(parent.name);
      parentGuid = parent.parentGuid;
    }
    if (normaliseSlnxPath(segments.join('/')) === normalizedFolderPath) {
      return guid;
    }
  }
  return undefined;
}

function upsertSlnNestedProject(content: string, childGuid: string, parentGuid: string): string {
  const nestedLine = `\t\t{${childGuid.toUpperCase()}} = {${parentGuid.toUpperCase()}}\n`;
  const nestedSection = content.match(/GlobalSection\(NestedProjects\)\s*=\s*preSolution[\s\S]*?EndGlobalSection/);
  if (nestedSection?.index !== undefined) {
    const childRegex = new RegExp(`\\t*\\s*\\{${escapeRegExp(childGuid)}\\}\\s*=\\s*\\{[^}]+\\}\\r?\\n?`, 'i');
    let updated = content.replace(childRegex, '');
    const updatedSection = updated.match(/GlobalSection\(NestedProjects\)\s*=\s*preSolution[\s\S]*?EndGlobalSection/);
    if (updatedSection?.index !== undefined) {
      const insertIndex = updatedSection.index + updatedSection[0].lastIndexOf('EndGlobalSection');
      updated = `${updated.slice(0, insertIndex)}${nestedLine}${updated.slice(insertIndex)}`;
    }
    return updated;
  }

  const endGlobalIndex = content.lastIndexOf('EndGlobal');
  const section = [
    '\tGlobalSection(NestedProjects) = preSolution',
    nestedLine.trimEnd(),
    '\tEndGlobalSection',
  ].join('\n');
  return endGlobalIndex >= 0
    ? `${content.slice(0, endGlobalIndex)}${section}\n${content.slice(endGlobalIndex)}`
    : `${content.trimEnd()}\nGlobal\n${section}\nEndGlobal\n`;
}

function isProjectUnderSlnxFolder(projectDir: string, folderPath: string): boolean {
  const normalisedProjectDir = normaliseSlnxPath(projectDir);
  return normalisedProjectDir === folderPath || normalisedProjectDir.startsWith(`${folderPath}/`);
}

function normaliseSlnxPath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .map(segment => segment.trim())
    .filter(Boolean)
    .join('/');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readUtf8(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString('utf-8');
}
