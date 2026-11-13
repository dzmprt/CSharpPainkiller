import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { removeUnusedUsingsFromContent } from '../services/removeUnusedUsings.js';
import { extractPublicMembers, generateInterfaceContent } from '../services/extractInterface.js';
import { clearNugetCaches, collectPackageVulnerabilities, collectProjectPackages, compareVersions, getNugetSources, showAddPackagePicker } from '../services/nugetCommands.js';
import {
	addPackageReferenceToCsproj,
	addPackageVersionToProps,
	getCentralPackageVersion,
	isAutomaticPackageCheckEnabled,
	parsePackageReferences,
	removePackageVersionFromProps,
	removeSlnFolder,
	removeSlnProject,
	updatePackageReferenceVersionInCsproj,
	updatePackageVersionInProps,
} from '../decoration/csprojProjectsTreeProvider.js';
import {
	parsePublicProperties,
	generateEfCoreEntityTypeConfiguration,
} from '../services/templates/efcore.js';
import {
	normalizeControllerName,
	generateEmptyController,
} from '../services/templates/aspnet.js';
import { generateFluentValidatorContent, generateFluentValidatorForDocument } from '../services/generateFluentValidator.js';
import { buildDtoContent, generateDtoForDocument } from '../services/generateDto.js';
import { csharpLanguageService } from '../services/csharpLanguageService.js';
import { buildExtractedFileContent } from '../services/extractTypeToFileCore.js';
import { type TypeFileContext } from '../utils/usingBlock.js';
import {
	buildDirectoryPackagesProps,
	createMigrationPlan,
	parseVersionedPackageReferences,
	removePackageVersions,
	migrateSolutionToCentralPackageManagement,
} from '../services/migrateToCentralPackageManagement.js';
import {
	capitalize,
	toPascalCase,
	toCamelCase,
	sanitizeIdentifier,
	formatNamespace,
	generateXmlDoc,
} from '../services/templates/shared/helpers.js';

suite('services', () => {
	test('generates a generic DTO with the source type arguments and constraints', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'painkiller-generic-dto-'));
		const sourceUri = vscode.Uri.file(path.join(directory, 'Box.cs'));
		const originalSymbols = csharpLanguageService.getSymbols;
		const originalInput = vscode.window.showInputBox;
		const originalShow = vscode.window.showTextDocument;
		try {
			const content = 'public class Box<T> where T : class, new() { public T Value { get; set; } }';
			await fs.writeFile(sourceUri.fsPath, content);
			const document = await vscode.workspace.openTextDocument(sourceUri);
			const box = new vscode.DocumentSymbol('Box', '', vscode.SymbolKind.Class,
				new vscode.Range(document.positionAt(0), document.positionAt(content.length)),
				new vscode.Range(document.positionAt(content.indexOf('Box')), document.positionAt(content.indexOf('Box') + 3)));
			const member = 'public T Value { get; set; }';
			const start = content.indexOf(member);
			const name = content.indexOf('Value');
			box.children.push(new vscode.DocumentSymbol('Value', '', vscode.SymbolKind.Property,
				new vscode.Range(document.positionAt(start), document.positionAt(start + member.length)),
				new vscode.Range(document.positionAt(name), document.positionAt(name + 5))));
			csharpLanguageService.getSymbols = async () => [box];
			Object.defineProperty(vscode.window, 'showInputBox', { configurable: true, value: async () => 'BoxDto' });
			Object.defineProperty(vscode.window, 'showTextDocument', { configurable: true, value: async () => undefined });
			await generateDtoForDocument(document, 'Box');
			const generated = await fs.readFile(path.join(directory, 'BoxDto.cs'), 'utf8');
			assert.ok(generated.includes('public class BoxDto<T>'));
			assert.ok(generated.includes('where T : class, new()'));
			assert.ok(generated.includes('public BoxDto(Box<T> source)'));
			assert.ok(generated.includes('Value = source.Value;'));
		} finally {
			csharpLanguageService.getSymbols = originalSymbols;
			Object.defineProperty(vscode.window, 'showInputBox', { configurable: true, value: originalInput });
			Object.defineProperty(vscode.window, 'showTextDocument', { configurable: true, value: originalShow });
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('validator commands exclude private getters and write-only properties', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'painkiller-validator-accessors-'));
		const uri = vscode.Uri.file(path.join(directory, 'Source.cs'));
		const originalSymbols = csharpLanguageService.getSymbols;
		const originalShow = vscode.window.showTextDocument;
		try {
			const members = [
				'public string Name { get; set; }',
				'public string Hidden { private get; set; }',
				'public string WriteOnly { set {} }',
			];
			const content = `public class Source { ${members.join(' ')} }`;
			await fs.writeFile(uri.fsPath, content);
			const document = await vscode.workspace.openTextDocument(uri);
			const source = new vscode.DocumentSymbol('Source', '', vscode.SymbolKind.Class,
				new vscode.Range(document.positionAt(0), document.positionAt(content.length)),
				new vscode.Range(document.positionAt(13), document.positionAt(19)));
			source.children = members.map((member, index) => {
				const name = ['Name', 'Hidden', 'WriteOnly'][index];
				const start = content.indexOf(member);
				const selection = content.indexOf(name, start);
				return new vscode.DocumentSymbol(name, '', vscode.SymbolKind.Property,
					new vscode.Range(document.positionAt(start), document.positionAt(start + member.length)),
					new vscode.Range(document.positionAt(selection), document.positionAt(selection + name.length)));
			});
			csharpLanguageService.getSymbols = async () => [source];
			Object.defineProperty(vscode.window, 'showTextDocument', { configurable: true, value: async () => undefined });
			await generateFluentValidatorForDocument(document, 'Source');
			const generated = await fs.readFile(path.join(directory, 'SourceValidator.cs'), 'utf8');
			assert.ok(generated.includes('RuleFor(x => x.Name)'));
			assert.ok(!generated.includes('Hidden') && !generated.includes('WriteOnly'));
		} finally {
			csharpLanguageService.getSymbols = originalSymbols;
			Object.defineProperty(vscode.window, 'showTextDocument', { configurable: true, value: originalShow });
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('DTOs and extracted types preserve file imports and nested namespace import scopes', () => {
		const context: TypeFileContext = {
			usings: ['using External;'],
			namespaces: [
				{ name: 'Outer', usings: ['using Payload = External.Payload;'] },
				{ name: 'Inner', usings: ['using static External.Helpers;'] },
			],
		};
		const dto = buildDtoContent('BookDto', 'Book', [{ name: 'Value', typeName: 'Payload' }], context, '\n');
		const extracted = buildExtractedFileContent('', 'public class Book { public Payload Value { get; set; } }', 'Outer.Inner', context);
		for (const content of [dto, extracted]) {
			assert.ok(content.startsWith('using External;\n'));
			assert.ok(content.includes('namespace Outer\n{\n    using Payload = External.Payload;'));
			assert.ok(content.includes('namespace Inner\n    {\n        using static External.Helpers;'));
			assert.ok(content.includes('public Payload Value'));
		}
	});

	suite('compareVersions', () => {
		test('compares numeric segments, not strings (10 > 9)', () => {
			assert.ok(compareVersions('10.0.0', '9.0.0') > 0);
		});

		test('treats a release as greater than a prerelease of the same core version', () => {
			assert.ok(compareVersions('1.0.0', '1.0.0-beta') > 0);
			assert.ok(compareVersions('1.0.0-beta', '1.0.0') < 0);
		});

		test('handles missing patch/minor segments', () => {
			assert.ok(compareVersions('2.0', '1.9.9') > 0);
			assert.strictEqual(compareVersions('1.0', '1.0.0'), 0);
		});

		test('returns 0 for equal versions', () => {
			assert.strictEqual(compareVersions('3.1.4', '3.1.4'), 0);
		});
	});

		suite('NuGet source configuration', () => {
			async function withConfigs<T>(configs: ReadonlyMap<string, string>, work: (projectPath: string) => Promise<T>): Promise<T> {
				const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'painkiller-sources-'));
				clearNugetCaches();
				try {
					await fs.mkdir(path.join(directory, 'App'));
					for (const [relativePath, content] of configs) {
						const filePath = path.join(directory, relativePath);
						await fs.mkdir(path.dirname(filePath), { recursive: true });
						await fs.writeFile(filePath, content);
					}
					return await work(path.join(directory, 'App', 'App.csproj'));
				} finally {
					clearNugetCaches();
					await fs.rm(directory, { recursive: true, force: true });
				}
			}

			test('respects clear and does not reintroduce a disabled public source', async () => {
				await withConfigs(new Map([['App/nuget.config', [
					'<configuration><packageSources>',
					'<clear /><add value="https://private.invalid/v3/index.json" key="Private" />',
					'</packageSources><disabledPackageSources><add key="nuget.org" value="true" /></disabledPackageSources></configuration>',
				].join('\n')]]), async projectPath => {
					assert.deepStrictEqual(await getNugetSources(projectPath), [
						{ name: 'Private', url: 'https://private.invalid/v3/index.json' },
					]);
				});
			});

			test('applies inherited removals, overrides and disabled-source re-enabling', async () => {
				await withConfigs(new Map([
					['nuget.config', '<configuration><packageSources><clear /><add key="Legacy" value="https://legacy.invalid" /><add key="Shared" value="https://old.invalid" /></packageSources><disabledPackageSources><add key="Shared" value="true" /></disabledPackageSources></configuration>'],
					['App/nuget.config', '<configuration><packageSources><remove key="Legacy" /><add key="Shared" value="https://new.invalid" /><add key="Extra" value="https://extra.invalid" /></packageSources><disabledPackageSources><add key="Shared" value="false" /></disabledPackageSources></configuration>'],
				]), async projectPath => {
					assert.deepStrictEqual(await getNugetSources(projectPath), [
						{ name: 'Shared', url: 'https://new.invalid' }, { name: 'Extra', url: 'https://extra.invalid' },
					]);
				});
			});

			test('reports no enabled sources instead of falling back after all sources are disabled', async () => {
				const originalError = vscode.window.showErrorMessage;
				let message = '';
				try {
					Object.defineProperty(vscode.window, 'showErrorMessage', { configurable: true, value: async (text: string) => { message = text; } });
					await withConfigs(new Map([['App/nuget.config',
						'<configuration><disabledPackageSources><add key="nuget.org" value="true" /></disabledPackageSources></configuration>',
					]]), async projectPath => {
						assert.deepStrictEqual(await getNugetSources(projectPath), []);
						assert.strictEqual(await showAddPackagePicker(projectPath), undefined);
						assert.ok(message.includes('No enabled NuGet sources'));
					});
				} finally {
					Object.defineProperty(vscode.window, 'showErrorMessage', { configurable: true, value: originalError });
				}
			});

			test('does not fall back to public sources when a configuration entry is invalid', async () => {
				await withConfigs(new Map([['App/nuget.config',
					'<configuration><packageSources><clear /><add key="Private" /></packageSources></configuration>',
				]]), async projectPath => {
					await assert.rejects(getNugetSources(projectPath), /value is required/);
				});
			});
		});

	suite('collectPackageVulnerabilities', () => {
		test('includes vulnerabilities from transitive packages', () => {
			const vulnerabilities = collectPackageVulnerabilities({
				projects: [{
					frameworks: [{
						topLevelPackages: [{
							id: 'Direct.Package',
							resolvedVersion: '1.2.3',
							vulnerabilities: [{ severity: 'High', advisoryUrl: 'https://example.test/direct' }],
						}],
						transitivePackages: [{
							id: 'Transitive.Package',
							resolvedVersion: '4.5.6',
							vulnerabilities: [{ severity: 'Critical', advisoryUrl: 'https://example.test/transitive' }],
						}],
					}],
				}],
			});

			assert.deepStrictEqual(vulnerabilities, [
				{
					id: 'Direct.Package',
					version: '1.2.3',
					severity: 'High',
					advisoryUrl: 'https://example.test/direct',
				},
				{
					id: 'Transitive.Package',
					version: '4.5.6',
					severity: 'Critical',
					advisoryUrl: 'https://example.test/transitive',
				},
			]);
		});
	});

	suite('collectProjectPackages', () => {
		test('includes resolved transitive packages', () => {
			const packages = collectProjectPackages({
				projects: [{
					frameworks: [{
						topLevelPackages: [{
							id: 'Direct.Package',
							requestedVersion: '1.0.0',
							resolvedVersion: '1.0.1',
						}],
						transitivePackages: [{
							id: 'Nested.Package',
							resolvedVersion: '2.3.4',
						}],
					}],
				}],
			});

			assert.deepStrictEqual(packages.get('direct.package'), {
				id: 'Direct.Package',
				requestedVersion: '1.0.0',
				resolvedVersion: '1.0.1',
			});
			assert.deepStrictEqual(packages.get('nested.package'), {
				id: 'Nested.Package',
				requestedVersion: undefined,
				resolvedVersion: '2.3.4',
			});
		});
	});

	suite('parsePackageReferences', () => {
		test('reads self-closing PackageReference version attributes', () => {
			const packages = parsePackageReferences('<PackageReference Include="Newtonsoft.Json" Version="13.0.3" />');

			assert.deepStrictEqual(packages, [{ name: 'Newtonsoft.Json', version: '13.0.3' }]);
		});

		test('reads nested PackageReference Version elements', () => {
			const packages = parsePackageReferences([
				'<PackageReference Include="Serilog">',
				'  <Version>3.1.1</Version>',
				'</PackageReference>',
			].join('\n'));

			assert.deepStrictEqual(packages, [{ name: 'Serilog', version: '3.1.1' }]);
		});

		test('keeps PackageReference entries without local versions', () => {
			const packages = parsePackageReferences([
				'<PackageReference Include="Humanizer.Core" />',
				'<PackageReference Include="xunit">',
				'  <PrivateAssets>all</PrivateAssets>',
				'</PackageReference>',
			].join('\n'));

			assert.deepStrictEqual(packages, [
				{ name: 'Humanizer.Core', version: undefined },
				{ name: 'xunit', version: undefined },
			]);
		});
	});

	suite('central package management migration', () => {
		test('rejects explicit or conditional project opt-outs before creating any updates', () => {
			for (const settings of [
				'<ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally>',
				'<ManagePackageVersionsCentrally Condition="\'$(TargetFramework)\' == \'net8.0\'">false</ManagePackageVersionsCentrally>',
			]) {
				const plan = createMigrationPlan(new Map([
					['A.csproj', `<Project><PropertyGroup>${settings}</PropertyGroup><PackageReference Include="A" Version="1.0.0" /></Project>`],
					['B.csproj', '<Project><PackageReference Include="B" Version="2.0.0" /></Project>'],
				]));
				assert.strictEqual(plan.projectUpdates.size, 0);
				assert.ok(plan.conflicts.some(conflict => conflict.includes('A.csproj') && conflict.includes('explicitly disabled')));
			}
			const commented = createMigrationPlan(new Map([['A.csproj',
				'<Project><!-- <ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally> --><PackageReference Include="A" Version="1.0.0" /></Project>',
			]]));
			assert.deepStrictEqual(commented.conflicts, []);
			assert.strictEqual(commented.projectUpdates.size, 1);
		});

		test('preserves nested central versions and detects their conflicts', () => {
			const props = '<Project>\n<ItemGroup>\n<PackageVersion Include="A">\n<Version>1.0.0</Version>\n</PackageVersion>\n</ItemGroup>\n</Project>';
			const matching = buildDirectoryPackagesProps(props, new Map([['A', '1.0.0']]));
			assert.strictEqual((matching.content!.match(/<PackageVersion\b/g) ?? []).length, 1);
			assert.ok(matching.content!.includes('<Version>1.0.0</Version>'));
			const conflict = createMigrationPlan(new Map([['A.csproj', '<PackageReference Include="A" Version="2.0.0" />']]), props);
			assert.deepStrictEqual(conflict.conflicts, ['A: 1.0.0 vs 2.0.0']);
			assert.strictEqual(conflict.projectUpdates.size, 0);
		});

		test('rejects nested props without changing any migration files or asking to migrate', async () => {
			const originalFind = vscode.workspace.findFiles;
			const originalError = vscode.window.showErrorMessage;
			const originalInfo = vscode.window.showInformationMessage;
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'painkiller-migration-'));
			const rootProps = vscode.Uri.file(path.join(directory, 'Directory.Packages.props'));
			const nested = vscode.Uri.file(path.join(directory, 'A', 'Directory.Packages.props'));
			const project = vscode.Uri.file(path.join(directory, 'A', 'A.csproj'));
			const propsContent = '<Project />';
			const projectContent = '<Project><PackageReference Include="A" Version="1.0.0" /></Project>';
			let confirmations = 0;
			let message = '';
			try {
				await fs.mkdir(path.dirname(project.fsPath));
				await fs.writeFile(rootProps.fsPath, propsContent);
				await fs.writeFile(nested.fsPath, propsContent);
				await fs.writeFile(project.fsPath, projectContent);
				Object.defineProperty(vscode.workspace, 'findFiles', { configurable: true, value: async (pattern: vscode.RelativePattern) =>
					pattern.pattern.endsWith('.csproj') ? [project] : [rootProps, nested] });
				Object.defineProperty(vscode.window, 'showErrorMessage', { configurable: true, value: async (text: string) => { message = text; } });
				Object.defineProperty(vscode.window, 'showInformationMessage', { configurable: true, value: async () => { confirmations++; return 'Migrate'; } });
				await migrateSolutionToCentralPackageManagement(vscode.Uri.file(path.join(directory, 'Main.sln')));
				assert.ok(message.includes('Nested Directory.Packages.props'));
				assert.ok(message.includes(nested.fsPath));
				assert.strictEqual(confirmations, 0);
				assert.strictEqual(await fs.readFile(rootProps.fsPath, 'utf8'), propsContent);
				assert.strictEqual(await fs.readFile(nested.fsPath, 'utf8'), propsContent);
				assert.strictEqual(await fs.readFile(project.fsPath, 'utf8'), projectContent);
			} finally {
				Object.defineProperty(vscode.workspace, 'findFiles', { configurable: true, value: originalFind });
				Object.defineProperty(vscode.window, 'showErrorMessage', { configurable: true, value: originalError });
				Object.defineProperty(vscode.window, 'showInformationMessage', { configurable: true, value: originalInfo });
				await fs.rm(directory, { recursive: true, force: true });
			}
		});

		test('allows a single root props file and migrates the project version', async () => {
			const originalFind = vscode.workspace.findFiles;
			const originalInfo = vscode.window.showInformationMessage;
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'painkiller-migration-'));
			const rootProps = vscode.Uri.file(path.join(directory, 'Directory.Packages.props'));
			const project = vscode.Uri.file(path.join(directory, 'A', 'A.csproj'));
			try {
				await fs.mkdir(path.dirname(project.fsPath));
				await fs.writeFile(rootProps.fsPath, '<Project><ItemGroup><PackageVersion Include="A" Version="1.0.0" /></ItemGroup></Project>');
				await fs.writeFile(project.fsPath, '<Project><PackageReference Include="A" Version="1.0.0" /></Project>');
				Object.defineProperty(vscode.workspace, 'findFiles', { configurable: true, value: async (pattern: vscode.RelativePattern) =>
					pattern.pattern.endsWith('.csproj') ? [project] : [rootProps] });
				Object.defineProperty(vscode.window, 'showInformationMessage', { configurable: true, value: async () => 'Migrate' });
				await migrateSolutionToCentralPackageManagement(vscode.Uri.file(path.join(directory, 'Main.sln')));
				const props = await fs.readFile(rootProps.fsPath, 'utf8');
				assert.ok(!(await fs.readFile(project.fsPath, 'utf8')).includes('Version='));
				assert.strictEqual((props.match(/<PackageVersion\b/g) ?? []).length, 1);
				assert.ok(props.includes('<ManagePackageVersionsCentrally>true'));
			} finally {
				Object.defineProperty(vscode.workspace, 'findFiles', { configurable: true, value: originalFind });
				Object.defineProperty(vscode.window, 'showInformationMessage', { configurable: true, value: originalInfo });
				await fs.rm(directory, { recursive: true, force: true });
			}
		});

		test('rejects project-dependent version expressions before producing any updates', () => {
			for (const version of ['$(PackageVersion)', '$([System.String]::Concat(1, 2))', '@(Versions)', '%(Version)']) {
				const plan = createMigrationPlan(new Map([
					['A.csproj', `<Project><PackageReference Include="Serilog" Version="${version}" /></Project>`],
					['B.csproj', '<Project><PackageReference Include="Moq" Version="4.20.0" /></Project>'],
				]));
				assert.strictEqual(plan.projectUpdates.size, 0);
				assert.ok(plan.conflicts.some(conflict => conflict.includes('A.csproj') && conflict.includes('MSBuild expression')));
			}
		});

		test('parses attribute and child PackageReference versions', () => {
			assert.deepStrictEqual(
				parseVersionedPackageReferences([
					'<PackageReference Include="Serilog" Version="3.1.1" />',
					'<PackageReference Include="Moq">',
					'  <Version>4.20.0</Version>',
					'</PackageReference>',
					'<PackageReference Include="NoVersion" />',
				].join('\n')),
				[
					{ name: 'Serilog', version: '3.1.1' },
					{ name: 'Moq', version: '4.20.0' },
				],
			);
		});

		test('removes local versions while preserving other metadata', () => {
			const updated = removePackageVersions([
				'<PackageReference Include="Serilog" Version="3.1.1" />',
				'<PackageReference Include="Moq">',
				'  <Version>4.20.0</Version>',
				'  <PrivateAssets>all</PrivateAssets>',
				'</PackageReference>',
			].join('\n'), new Set(['Serilog', 'Moq']));

			assert.ok(!updated.includes('Version="3.1.1"'));
			assert.ok(!updated.includes('<Version>4.20.0</Version>'));
			assert.ok(updated.includes('<PrivateAssets>all</PrivateAssets>'));
		});

		test('creates Directory.Packages.props and project updates', () => {
			const plan = createMigrationPlan(new Map([
				['A.csproj', '<Project><PackageReference Include="Serilog" Version="3.1.1" /></Project>'],
			]));
			const props = buildDirectoryPackagesProps(undefined, plan.centralVersions).content!;

			assert.strictEqual(plan.conflicts.length, 0);
			assert.ok(props.includes('<ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>'));
			assert.ok(props.includes('Include="Serilog" Version="3.1.1"'));
			const updatedProject = plan.projectUpdates.get('A.csproj')!;
			assert.ok(updatedProject.includes('<PackageReference Include="Serilog"'));
			assert.ok(!updatedProject.includes('Version="3.1.1"'));
		});

		test('reports conflicting versions before producing updates', () => {
			const plan = createMigrationPlan(new Map([
				['A.csproj', '<PackageReference Include="Serilog" Version="3.1.1" />'],
				['B.csproj', '<PackageReference Include="Serilog" Version="4.0.0" />'],
			]));

			assert.strictEqual(plan.projectUpdates.size, 0);
			assert.ok(plan.conflicts.some(conflict => conflict.includes('Serilog')));
		});

		test('enables existing central management and preserves existing entries', () => {
			const existingProps = [
				'<Project>',
				'  <PropertyGroup><ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally></PropertyGroup>',
				'  <ItemGroup><PackageVersion Include="Moq" Version="4.20.0" /></ItemGroup>',
				'</Project>',
			].join('\n');
			const plan = createMigrationPlan(
				new Map([
					['A.csproj', '<PackageReference Include="Serilog" Version="3.1.1" />'],
				]),
				existingProps,
			);
			const props = buildDirectoryPackagesProps(existingProps, plan.centralVersions).content!;

			assert.strictEqual(plan.conflicts.length, 0);
			assert.ok(props.includes('<ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>'));
			assert.ok(props.includes('Include="Moq" Version="4.20.0"'));
			assert.ok(props.includes('Include="Serilog" Version="3.1.1"'));
			assert.ok(!plan.projectUpdates.get('A.csproj')!.includes('Version="3.1.1"'));
		});
	});

	suite('central package management when adding packages', () => {
		test('does not read the next package version for a self-closing unversioned entry', () => {
			const content = '<PackageVersion Include="A" />\n<PackageVersion Include="B"><Version>2.0.0</Version></PackageVersion>';
			assert.strictEqual(getCentralPackageVersion(content, 'A'), undefined);
			assert.strictEqual(getCentralPackageVersion(content, 'B'), '2.0.0');
			assert.strictEqual(updatePackageVersionInProps(content, 'A', '3.0.0'),
				'<PackageVersion Include="A" Version="3.0.0" />\n<PackageVersion Include="B"><Version>2.0.0</Version></PackageVersion>');
		});

		test('reads attribute and nested central versions', () => {
			const content = [
				'<Project><ItemGroup>',
				'  <PackageVersion Include="Serilog" Version="3.1.1" />',
				'  <PackageVersion Include="Moq"><Version>4.20.0</Version></PackageVersion>',
				'</ItemGroup></Project>',
			].join('\n');

			assert.strictEqual(getCentralPackageVersion(content, 'Serilog'), '3.1.1');
			assert.strictEqual(getCentralPackageVersion(content, 'Moq'), '4.20.0');
			assert.strictEqual(getCentralPackageVersion(content, 'Missing'), undefined);
		});

		test('adds a missing central version and omits the project version', () => {
			const props = '<Project>\n  <ItemGroup>\n  </ItemGroup>\n</Project>\n';
			const updatedProps = addPackageVersionToProps(props, 'FluentValidation', '11.3.0');
			const updatedProject = addPackageReferenceToCsproj('<Project>\n</Project>\n', 'FluentValidation');

			assert.ok(updatedProps.includes('Include="FluentValidation" Version="11.3.0"'));
			assert.ok(updatedProject.includes('<PackageReference Include="FluentValidation" />'));
		});

		test('omits the project version for a matching central version', () => {
			const project = addPackageReferenceToCsproj('<Project>\n</Project>\n', 'Serilog');

			assert.ok(project.includes('<PackageReference Include="Serilog" />'));
		});

		test('keeps the project version for a conflicting central version', () => {
			const project = addPackageReferenceToCsproj('<Project>\n</Project>\n', 'Serilog', '4.0.0');

			assert.ok(project.includes('<PackageReference Include="Serilog" Version="4.0.0" />'));
		});

		test('removes an unused central package version while preserving other packages', () => {
			const props = [
				'<Project><ItemGroup>',
				'  <PackageVersion Include="Serilog" Version="3.1.1" />',
				'  <PackageVersion Include="Moq"><Version>4.20.0</Version></PackageVersion>',
				'</ItemGroup></Project>',
			].join('\n');

			const updated = removePackageVersionFromProps(props, 'Serilog');

			assert.ok(!updated.includes('Include="Serilog"'));
			assert.ok(updated.includes('Include="Moq"'));
		});

		test('removes nested central package versions case-insensitively', () => {
			const props = '<Project><ItemGroup>\n  <PackageVersion Include="SERILOG"><Version>3.1.1</Version></PackageVersion>\n</ItemGroup></Project>';

			assert.ok(!removePackageVersionFromProps(props, 'Serilog').includes('PackageVersion'));
		});
	});

	suite('updatePackageReferenceVersionInCsproj', () => {
		test('updates only the selected package when self-closing and paired entries are mixed', () => {
			const content = '<PackageReference Include="A" Version="1.0.0" />\n<PackageReference Include="B"><Version>2.0.0</Version><PrivateAssets>all</PrivateAssets></PackageReference>';
			assert.strictEqual(updatePackageReferenceVersionInCsproj(content, 'A', '3.0.0'),
				content.replace('Version="1.0.0"', 'Version="3.0.0"'));
			assert.strictEqual(updatePackageReferenceVersionInCsproj(content, 'B', '4.0.0'),
				content.replace('<Version>2.0.0</Version>', '<Version>4.0.0</Version>'));
		});

		test('updates nested PackageReference Version elements without adding a conflicting attribute', () => {
			const content = [
				'<Project>',
				'  <ItemGroup>',
				'    <PackageReference Include="Serilog">',
				'      <Version>3.1.1</Version>',
				'    </PackageReference>',
				'  </ItemGroup>',
				'</Project>',
			].join('\n');

			const updated = updatePackageReferenceVersionInCsproj(content, 'Serilog', '4.0.0');

			assert.ok(updated.includes('<Version>4.0.0</Version>'));
			assert.ok(!updated.includes('Include="Serilog" Version="4.0.0"'));
		});

		test('updates self-closing PackageReference version attributes', () => {
			const content = '<PackageReference Include="Newtonsoft.Json" Version="13.0.1" />';

			assert.strictEqual(
				updatePackageReferenceVersionInCsproj(content, 'Newtonsoft.Json', '13.0.3'),
				'<PackageReference Include="Newtonsoft.Json" Version="13.0.3" />',
			);
		});
	});

	suite('isAutomaticPackageCheckEnabled', () => {
		test('defaults to enabled', () => {
			assert.strictEqual(isAutomaticPackageCheckEnabled({ get: () => undefined }), true);
		});

		test('can be disabled from settings', () => {
			assert.strictEqual(isAutomaticPackageCheckEnabled({ get: () => false }), false);
		});
	});

		suite('solution project removal', () => {
			const folderGuid = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA';
			const firstGuid = '11111111-1111-1111-1111-111111111111';
			const secondGuid = '22222222-2222-2222-2222-222222222222';
			const folderBlock = [
				`Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "src", "src", "{${folderGuid}}"`,
				'\tProjectSection(SolutionItems) = preProject',
				'\t\tREADME.md = README.md',
				'\tEndProjectSection',
				'EndProject',
			].join('\r\n');
			const firstBlock = [
				`Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "A", "A\\A.csproj", "{${firstGuid}}"`,
				'\tProjectSection(ProjectDependencies) = postProject',
				`\t\t{${secondGuid}} = {${secondGuid}}`,
				'\tEndProjectSection',
				'EndProject',
			].join('\r\n');
			const secondBlock = [
				`Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "B", "B\\B.csproj", "{${secondGuid}}"`,
				'EndProject',
			].join('\r\n');
			const content = [
				'Microsoft Visual Studio Solution File, Format Version 12.00', folderBlock, firstBlock, secondBlock,
				'Global',
				'\tGlobalSection(ProjectConfigurationPlatforms) = postSolution',
				`\t\t{${firstGuid}}.Debug|Any CPU.ActiveCfg = Debug|Any CPU`,
				`\t\t{${secondGuid}}.Debug|Any CPU.ActiveCfg = Debug|Any CPU`,
				'\tEndGlobalSection',
				'\tGlobalSection(NestedProjects) = preSolution',
				`\t\t{${firstGuid}} = {${folderGuid}}`,
				'\tEndGlobalSection',
				'EndGlobal', '',
			].join('\r\n');

			test('removes complete project blocks and their configuration while preserving other projects and CRLF', () => {
				const updated = removeSlnProject(content, 'A/A.csproj');
				assert.ok(!updated.includes(firstGuid));
				assert.ok(!updated.includes('NestedProjects'));
				assert.ok(updated.includes(folderBlock));
				assert.ok(updated.includes(secondBlock));
				assert.ok(updated.includes(`{${secondGuid}}.Debug|Any CPU.ActiveCfg`));
				assert.ok(!/(?<!\r)\n/.test(updated));
			});

			test('removes folders with solution items and complete nested project blocks', () => {
				const updated = removeSlnFolder(content, folderGuid.toLowerCase());
				assert.ok(!updated.includes(folderGuid));
				assert.ok(!updated.includes(firstGuid));
				assert.ok(!updated.includes('SolutionItems'));
				assert.ok(!updated.includes('ProjectDependencies'));
				assert.ok(updated.includes(secondBlock));
				assert.ok(!/(?<!\r)\n/.test(updated));
			});
		});

	suite('removeUnusedUsingsFromContent', () => {
		test('removes unused using directives', () => {
			const content = [
				'using MyApp.Domain;',
				'using System.IO;',
				'namespace MyApp;',
				'public class Handler { private readonly DomainService _service; }',
			].join('\n');
			const updated = removeUnusedUsingsFromContent(content);
			assert.ok(updated);
			assert.ok(updated!.includes('using MyApp.Domain;'));
			assert.ok(!updated!.includes('using System.IO;'));
		});

		test('returns undefined when all usings are used', () => {
			const content = [
				'using MyApp.Domain;',
				'namespace MyApp;',
				'public class Handler { private readonly DomainService _service; }',
			].join('\n');
			assert.strictEqual(removeUnusedUsingsFromContent(content), undefined);
		});

		test('does not remove code before a nested using directive', () => {
			const content = [
				'using System.IO;',
				'',
				'namespace MyApp',
				'{',
				'    public class Book { }',
				'    using Nested;',
				'}',
			].join('\n');

			const updated = removeUnusedUsingsFromContent(content);

			assert.ok(updated);
			assert.ok(updated!.includes('public class Book { }'));
			assert.ok(updated!.includes('    using Nested;'));
		});
	});

	suite('extractPublicMembers', () => {
		test('extracts only instance members while preserving instance accessor visibility', () => {
			const members = extractPublicMembers([
				'public class Service {',
				'    public static int Count { get; set; }',
				'    public static string Title => "";',
				'    public new static void Reset() {}',
				'    public string Name { get; private set; }',
				'    public void Save() {}',
				'}',
			].join('\n'));
			assert.ok(members);
			const generated = generateInterfaceContent(members, 'IService', undefined, '\n');
			assert.ok(generated.includes('string Name { get; }'));
			assert.ok(generated.includes('void Save();'));
			assert.ok(!generated.includes('Count') && !generated.includes('Title') && !generated.includes('Reset'));
		});

		test('preserves class and method type parameters and constraints', () => {
			const members = extractPublicMembers([
				'public class Box<T, U> : BaseBox<T>',
				'    where T : class, new()',
				'    where U : System.Collections.Generic.IEnumerable<T>',
				'{',
				'    public T Value { get; set; }',
				'    public U Items { get; init; }',
				'    public TResult Convert<TResult>(T value) where TResult : class, new() => new TResult();',
				'}',
			].join('\n'));
			assert.ok(members);
			const generated = generateInterfaceContent(members, 'IBox', 'Example', '\r\n');
			assert.ok(generated.includes('public interface IBox<T, U>\r\n'));
			assert.ok(generated.includes('where T : class, new() where U : System.Collections.Generic.IEnumerable<T>'));
			assert.ok(generated.includes('T Value { get; set; }'));
			assert.ok(generated.includes('U Items { get; init; }'));
			assert.ok(generated.includes('TResult Convert<TResult>(T value) where TResult : class, new();'));
			assert.ok(!generated.includes('BaseBox'));
		});

		test('preserves only public accessors, including init and write-only properties', () => {
			const members = extractPublicMembers([
				'public class Book',
				'{',
				'    public string Name {get;private set;}',
				'    public int Age { get; init; }',
				'    public string Secret { private get; set; }',
				'    public int Size => 42;',
				'    public int Count { get { return 0; } set { Store(value); } }',
				'    public async void Notify() { }',
				'}',
			].join('\n'));
			assert.ok(members);
			const result = generateInterfaceContent(members, 'IBook', 'MyApp', '\n');
			assert.ok(result.includes('string Name { get; }'));
			assert.ok(result.includes('int Age { get; init; }'));
			assert.ok(result.includes('string Secret { set; }'));
			assert.ok(result.includes('int Size { get; }'));
			assert.ok(result.includes('int Count { get; set; }'));
			assert.ok(result.includes('void Notify();'));
		});

		test('extracts public properties and methods', () => {
			const content = [
				'namespace MyApp;',
				'public class BookService',
				'{',
				'    public string Title { get; set; }',
				'    public async Task SaveAsync() { }',
				'}',
			].join('\n');
			const members = extractPublicMembers(content);
			assert.ok(members);
			assert.strictEqual(members!.className, 'BookService');
			assert.strictEqual(members!.properties.length, 1);
			assert.strictEqual(members!.properties[0].name, 'Title');
			assert.strictEqual(members!.methods.length, 1);
			assert.strictEqual(members!.methods[0].name, 'SaveAsync');
			assert.ok(members!.methods[0].isAsync);
		});

		test('returns undefined when no public class exists', () => {
			assert.strictEqual(extractPublicMembers('namespace MyApp;'), undefined);
		});
	});

	suite('efcore templates', () => {
		test('parsePublicProperties parses nullable and non-nullable properties', () => {
			const content = [
				'public class Book',
				'{',
				'    public int Id { get; set; }',
				'    public string? Title { get; set; }',
				'    public string Author { get; init; }',
				'}',
			].join('\n');
			const props = parsePublicProperties(content);
			assert.strictEqual(props.length, 3);
			assert.strictEqual(props[0].name, 'Id');
			assert.strictEqual(props[1].isNullable, true);
			assert.strictEqual(props[2].type, 'string');
		});

		test('generateEfCoreEntityTypeConfiguration configures key and properties', () => {
			const entity = {
				name: 'Book',
				namespace: 'MyApp.Domain',
				fileUri: undefined as never,
			};
			const props = parsePublicProperties([
				'public class Book',
				'{',
				'    public int Id { get; set; }',
				'    public string Title { get; set; }',
				'}',
			].join('\n'));
			const content = generateEfCoreEntityTypeConfiguration(entity, props, 'MyApp.Infrastructure');
			assert.ok(content.includes('builder.HasKey(e => e.Id);'));
			assert.ok(content.includes('builder.Property(e => e.Title)'));
			assert.ok(content.includes('.IsRequired()'));
			assert.ok(content.includes('.HasMaxLength(256)'));
		});

		test('generates one-to-many relationship with an explicit foreign key', () => {
			const entity = { name: 'Book', namespace: 'MyApp.Domain', fileUri: undefined as never };
			const props = parsePublicProperties([
				'public class Book', '{',
				'    public int Id { get; set; }',
				'    public int AuthorId { get; set; }',
				'    public Author Author { get; set; }',
				'}',
			].join('\n'));
			const relatedProps = parsePublicProperties([
				'public class Author', '{',
				'    public ICollection<Book> Books { get; set; }',
				'}',
			].join('\n'));
			const content = generateEfCoreEntityTypeConfiguration(entity, props, 'MyApp.Infrastructure', {
				Author: relatedProps,
			});
			assert.ok(content.includes('builder.HasOne(e => e.Author)'));
			assert.ok(content.includes('.WithMany(e => e.Books)'));
			assert.ok(content.includes('.HasForeignKey(e => e.AuthorId)'));
			assert.ok(!content.includes('builder.Property(e => e.Author)'));
		});

		test('generates one-to-many relationship with a shadow foreign key', () => {
			const entity = { name: 'ProductPhoto', namespace: 'LTRS.Domain', fileUri: undefined as never };
			const props = parsePublicProperties([
				'public class ProductPhoto', '{',
				'    public Guid ProductPhotoId { get; private set; }',
				'    public byte[] PngFile { get; private set; }',
				'    public Product Product { get; private set; }',
				'}',
			].join('\n'));
			const productProps = parsePublicProperties([
				'public class Product', '{',
				'    public ICollection<ProductPhoto> Photos { get; private set; }',
				'}',
			].join('\n'));
			const content = generateEfCoreEntityTypeConfiguration(entity, props, 'MyApp.Infrastructure', {
				Product: productProps,
			});
			assert.ok(content.includes('builder.HasOne(e => e.Product)'));
			assert.ok(content.includes('.WithMany(e => e.Photos)'));
			assert.ok(content.includes('.HasForeignKey("ProductId")'));
			assert.ok(content.includes('.IsRequired();'));
			assert.ok(content.includes('builder.Property(e => e.PngFile)'));
			assert.ok(!content.includes('builder.HasMany(e => e.PngFile)'));
			assert.ok(!content.includes('builder.Property(e => e.Product)'));
		});

		test('generates a many-to-many relationship for collection navigation', () => {
			const entity = { name: 'Book', namespace: 'MyApp.Domain', fileUri: undefined as never };
			const props = parsePublicProperties([
				'public class Book', '{',
				'    public int Id { get; set; }',
				'    public ICollection<Tag> Tags { get; set; }',
				'}',
			].join('\n'));
			const tagProps = parsePublicProperties([
				'public class Tag', '{',
				'    public Book[] Posts { get; set; }',
				'}',
			].join('\n'));
			const content = generateEfCoreEntityTypeConfiguration(entity, props, 'MyApp.Infrastructure', {
				Tag: tagProps,
			});
			assert.ok(content.includes('builder.HasMany(e => e.Tags)'));
			assert.ok(content.includes('.WithMany(e => e.Posts);'));
			assert.ok(!content.includes('builder.Property(e => e.Tags)'));
		});

		test('generates one-to-one FK on the related dependent entity', () => {
			const entity = { name: 'Product', namespace: 'MyApp.Domain', fileUri: undefined as never };
			const props = parsePublicProperties([
				'public class Product', '{',
				'    public Guid ProductId { get; set; }',
				'    public ProductDetails? Details { get; set; }',
				'}',
			].join('\n'));
			const detailsProps = parsePublicProperties([
				'public class ProductDetails', '{',
				'    public Guid ProductId { get; set; }',
				'    public Product Product { get; set; }',
				'}',
			].join('\n'));
			const content = generateEfCoreEntityTypeConfiguration(entity, props, 'MyApp.Domain', {
				ProductDetails: detailsProps,
			});
			assert.ok(content.includes('.WithOne(e => e.Product)'));
			assert.ok(content.includes('.HasForeignKey<ProductDetails>(e => e.ProductId);'));
			assert.ok(!content.includes('.HasForeignKey("DetailsId")'));
		});

		test('uses one-to-many cardinality when inverse references are ambiguous', () => {
			const entity = { name: 'Department', namespace: 'MyApp.Domain', fileUri: undefined as never };
			const props = parsePublicProperties([
				'public class Department', '{',
				'    public Employee[] Employees { get; set; }',
				'}',
			].join('\n'));
			const employeeProps = parsePublicProperties([
				'public class Employee', '{',
				'    public Department Department { get; set; }',
				'    public Department? BackupDepartment { get; set; }',
				'}',
			].join('\n'));
			const content = generateEfCoreEntityTypeConfiguration(entity, props, 'MyApp.Domain', {
				Employee: employeeProps,
			});
			assert.ok(content.includes('.WithOne();'));
			assert.ok(!content.includes('.WithMany();'));

			const employeeEntity = { name: 'Employee', namespace: 'MyApp.Domain', fileUri: undefined as never };
			const employeeContent = generateEfCoreEntityTypeConfiguration(employeeEntity, employeeProps, 'MyApp.Domain', {
				Department: props,
			});
			assert.ok(employeeContent.includes('.HasForeignKey("DepartmentId")'));
			assert.ok(employeeContent.includes('.HasForeignKey("BackupDepartmentId")'));
			assert.ok(!employeeContent.includes('__RELATIONSHIP_FOREIGN_KEY_REQUIRED__'));
		});

		test('emits a key placeholder when the key convention cannot identify a key', () => {
			const entity = { name: 'LegacyEntity', namespace: 'MyApp.Domain', fileUri: undefined as never };
			const props = parsePublicProperties([
				'public class LegacyEntity', '{',
				'    public Guid LegacyIdentifier { get; set; }',
				'}',
			].join('\n'));
			const content = generateEfCoreEntityTypeConfiguration(entity, props, 'MyApp.Domain');
			assert.ok(content.includes('builder.HasKey(e => ...);'));
		});

		test('configures the inverse reference navigation as the collection foreign key', () => {
			const entity = { name: 'Product', namespace: 'MyApp.Domain', fileUri: undefined as never };
			const props = parsePublicProperties([
				'public class Product', '{',
				'    public ProductPhoto[] Photos { get; set; }',
				'}',
			].join('\n'));
			const productPhotoProps = parsePublicProperties([
				'public class ProductPhoto', '{',
				'    public Product Product { get; set; }',
				'}',
			].join('\n'));
			const content = generateEfCoreEntityTypeConfiguration(entity, props, 'MyApp.Infrastructure', {
				ProductPhoto: productPhotoProps,
			});
			assert.ok(content.includes('builder.HasMany(e => e.Photos)'));
			assert.ok(content.includes('.WithOne(e => e.Product)'));
			assert.ok(content.includes('.HasForeignKey("ProductId");'));

			const explicitProductPhotoProps = parsePublicProperties([
				'public class ProductPhoto', '{',
				'    public Guid ProductId { get; set; }',
				'    public Product Product { get; set; }',
				'}',
			].join('\n'));
			const explicitContent = generateEfCoreEntityTypeConfiguration(entity, props, 'MyApp.Infrastructure', {
				ProductPhoto: explicitProductPhotoProps,
			});
			assert.ok(explicitContent.includes('.HasForeignKey(e => e.ProductId);'));
		});

		test('recognizes virtual collection navigation properties', () => {
			const entity = { name: 'Book', namespace: 'MyApp.Domain', fileUri: undefined as never };
			const props = parsePublicProperties([
				'public class Book', '{',
				'    public virtual ICollection<Tag> Tags { get; set; }',
				'}',
			].join('\n'));
			assert.strictEqual(props[0].type, 'ICollection<Tag>');
			const content = generateEfCoreEntityTypeConfiguration(entity, props, 'MyApp.Infrastructure');
			assert.ok(content.includes('builder.HasMany(e => e.Tags)'));
		});
	});

	suite('aspnet templates', () => {
		test('normalizeControllerName strips Controller suffix', () => {
			assert.strictEqual(normalizeControllerName('AuthorsController'), 'Authors');
			assert.strictEqual(normalizeControllerName('Authors'), 'Authors');
		});

		test('generateEmptyController creates ApiController', () => {
			const content = generateEmptyController('Authors', 'MyApp.Api');
			assert.ok(content.includes('public class AuthorsController : ControllerBase'));
			assert.ok(content.includes('[ApiController]'));
		});
	});

	suite('generateFluentValidatorContent', () => {
		test('validates collections separately from their elements and permits nullable collections', () => {
			const content = generateFluentValidatorContent('Book', [
				{ name: 'Items', type: 'List<string>', isNullable: false },
				{ name: 'OptionalItems', type: 'string[]', isNullable: true },
			], 'Example', '\n', new Set());
			assert.ok(content.includes('RuleFor(x => x.Items)\n            .NotNull()\n            .NotEmpty();'));
			assert.ok(content.includes('RuleFor(x => x.OptionalItems)\n            .NotEmpty().When(x => x.OptionalItems != null);'));
			assert.ok(content.includes('RuleForEach(x => x.Items)\n            .ChildRules'));
			assert.ok(!content.includes('RuleForEach(x => x.Items)\n            .Not'));
		});

		test('omits nullable properties with no inferred validation rule', () => {
			const content = generateFluentValidatorContent('Book', [
				{ name: 'Date', type: 'DateTime', isNullable: true },
				{ name: 'Id', type: 'Guid', isNullable: true },
				{ name: 'Author', type: 'Author', isNullable: true },
				{ name: 'Title', type: 'string', isNullable: true },
			], 'MyApp', '\n', new Set());
			assert.ok(!content.includes('RuleFor(x => x.Date)'));
			assert.ok(!content.includes('RuleFor(x => x.Id)'));
			assert.ok(!content.includes('RuleFor(x => x.Author)'));
			assert.ok(content.includes('RuleFor(x => x.Title)\n            .MaximumLength(256);'));
		});

		test('generates validator with string rules', () => {
			const content = generateFluentValidatorContent(
				'Book',
				[{ name: 'Title', type: 'string', isNullable: false }],
				'MyApp.Validators',
				'\n',
				new Set<string>()
			);
			assert.ok(content.includes('public class BookValidator : AbstractValidator<Book>'));
			assert.ok(content.includes('RuleFor(x => x.Title)'));
			assert.ok(content.includes('.NotEmpty()'));
			assert.ok(content.includes('.MaximumLength(256);'));
		});
	});

	suite('template shared helpers', () => {
		test('capitalize', () => {
			assert.strictEqual(capitalize('book'), 'Book');
		});

		test('toPascalCase', () => {
			assert.strictEqual(toPascalCase('my class'), 'MyClass');
		});

		test('toCamelCase', () => {
			assert.strictEqual(toCamelCase('MyClass'), 'myClass');
		});

		test('sanitizeIdentifier', () => {
			assert.strictEqual(sanitizeIdentifier('123-name'), '_123name');
			assert.strictEqual(sanitizeIdentifier(''), 'GeneratedClass');
		});

		test('formatNamespace', () => {
			assert.strictEqual(formatNamespace('my-app/domain'), 'Myapp.Domain');
		});

		test('generateXmlDoc', () => {
			assert.ok(generateXmlDoc('Summary text.').includes('/// Summary text.'));
		});
	});
});
