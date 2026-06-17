import * as vscode from 'vscode';
import { spawnSync } from 'child_process';
import * as pathModule from 'path';

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

// ---------------------------------------------------------------------------
// Parsing: run `dotnet new list` and parse the text table output
// ---------------------------------------------------------------------------

function parseDotnetNewList(): Array<{ name: string; shorthand: string; language: string; tags: string }> {
  try {
    const result = spawnSync('dotnet', ['new', 'list'], {
      timeout: 30_000,
      shell: false,
    });

    if (result.error) {
      vscode.window.showErrorMessage(`Failed to list .NET templates: ${result.error.message}`);
      return [];
    }

    const output = (result.stdout?.toString() || result.stderr?.toString() || '').replace(/^\r?\n/, ''); // remove leading blank line
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

    return templates;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    vscode.window.showWarningMessage(`Could not list .NET templates: ${msg}`);
    return [];
  }
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

  if (relevantShorthands.has(shorthand)) {
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

export async function fetchDotnetTemplates(_context: vscode.ExtensionContext): Promise<DotnetTemplate[]> {
  const rawTemplates = parseDotnetNewList();

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
}

// ---------------------------------------------------------------------------
// Dynamic command registration: registers commands and submenu entries
// ---------------------------------------------------------------------------

export interface TemplateMenuEntry {
  template: DotnetTemplate;
  commandDisposable: vscode.Disposable;
}

export function registerDynamicTemplateCommands(templates: DotnetTemplate[], context: vscode.ExtensionContext): TemplateMenuEntry[] {
  const entries: TemplateMenuEntry[] = [];

  for (const template of templates) {
    const disposable = vscode.commands.registerCommand(
      template.classId,
      async () => {
        await createProjectByTemplate(template);
      }
    );

    context.subscriptions.push(disposable);
    entries.push({ template, commandDisposable: disposable });
  }

  // Register the unified "Create .NET Project" command that shows grouped templates
  registerUnifiedCreateProjectCommand(templates, context);

  return entries;
}

// ---------------------------------------------------------------------------
// Unified "Create .NET Project" command with grouped QuickPick
// ---------------------------------------------------------------------------

function registerUnifiedCreateProjectCommand(templates: DotnetTemplate[], context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand(
    'csharppainkiller.dotnet.createProject',
    async (uri?: vscode.Uri) => {
      // Sort templates by shorthand for consistent ordering
      const sortedTemplates = [...templates].sort((a, b) => a.shorthand.localeCompare(b.shorthand));

      // Build flat QuickPick list
      const picks: vscode.QuickPickItem[] = sortedTemplates.map(t => ({
        label: `$(file-code) ${t.name}`,
        description: t.shorthand,
        detail: `dotnet new ${t.shorthand}`,
      }));

      const pick = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Select a .NET template to create',
        canPickMany: false,
      });

      if (pick) {
        const template = sortedTemplates.find(t => t.shorthand === pick.description);
        if (template) {
          await createProjectByTemplate(template, uri);
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

async function createProjectByTemplate(template: DotnetTemplate, selectedUri?: vscode.Uri): Promise<void> {
  // Use the URI from explorer selection (folder), or fall back to workspace root
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('CSharp Painkiller: No workspace folder open. Open a folder to create a project.');
    return;
  }

  // If user right-clicked a folder in explorer, use that folder as the base
  let baseFolderUri: vscode.Uri;
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

  // Search for solution near baseFolderUri
  const solution = await findSolutionFileNear(baseFolderUri);

  try {
    // Ensure parent directory exists
    await ensureDirectoryExists(pathModule.dirname(projectFolderPath.fsPath));

    // Build and run dotnet new command
    const newArgs = ['new', template.shorthand, '-o', projectFolderPath.fsPath, '--name', projectName];

    if (solution) {
      const slnDir = pathModule.dirname(solution.fsPath);
      runDotnetCommand(newArgs, slnDir);

      // Add to solution
      await addProjectToSolution(solution, projectFolderPath, projectName, slnDir);

      vscode.window.showInformationMessage(`Created ${template.name} project "${projectName}" and added to solution.`);
    } else {
      runDotnetCommand(newArgs, pathModule.dirname(projectFolderPath.fsPath));
      vscode.window.showInformationMessage(`Created ${template.name} project "${projectName}".`);
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to create ${template.name} project: ${error instanceof Error ? error.message : String(error)}`);
  }
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

function runDotnetCommand(args: string[], cwd: string): void {
  try {
    const result = spawnSync('dotnet', args, {
      cwd,
      stdio: 'inherit',
      timeout: 120_000,
      shell: false,
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      const stderr = result.stderr?.toString() || '';
      const stdout = result.stdout?.toString() || '';
      throw new Error(stderr || stdout || `Command exited with code ${result.status}`);
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Failed to run dotnet ${args.join(' ')}: ${msg}`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Helper: ensure directory exists
// ---------------------------------------------------------------------------

async function ensureDirectoryExists(dirPath: string): Promise<void> {
  const fsModule = await import('fs');
  if (!fsModule.existsSync(dirPath)) {
    fsModule.mkdirSync(dirPath, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Helper: add project to solution (simplified from dotnetCommands.ts)
// ---------------------------------------------------------------------------

async function addProjectToSolution(_solutionUri: vscode.Uri, projectFolderUri: vscode.Uri, _projectName: string, slnDir: string): Promise<boolean> {
  try {
      runDotnetCommand(['sln', 'add', projectFolderUri.fsPath], slnDir);
    return true;
  } catch {
    console.error('Failed to add project to solution');
    return false;
  }
}
