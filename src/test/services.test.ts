import * as assert from 'assert';
import { sortUsingsInContent } from '../services/sortUsings.js';
import { removeUnusedUsingsFromContent } from '../services/removeUnusedUsings.js';
import { extractPublicMembers } from '../services/extractInterface.js';
import { collectTopLevelUsingBlock, isUsingOrderSorted } from '../utils/usingBlock.js';
import { collectPackageVulnerabilities, collectProjectPackages, compareVersions } from '../services/nugetCommands.js';
import {
	addPackageReferenceToCsproj,
	addPackageVersionToProps,
	getCentralPackageVersion,
	isAutomaticPackageCheckEnabled,
	parsePackageReferences,
	removePackageVersionFromProps,
	updatePackageReferenceVersionInCsproj,
} from '../decoration/csprojProjectsTreeProvider.js';
import {
	parsePublicProperties,
	generateEfCoreEntityTypeConfiguration,
} from '../services/templates/efcore.js';
import {
	normalizeControllerName,
	generateEmptyController,
} from '../services/templates/aspnet.js';
import { generateFluentValidatorContent } from '../services/generateFluentValidator.js';
import {
	buildDirectoryPackagesProps,
	createMigrationPlan,
	parseVersionedPackageReferences,
	removePackageVersions,
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
	suite('sortUsingsInContent', () => {
		test('sorts System usings first', () => {
			const content = [
				'using MyApp.Domain;',
				'using System.Linq;',
				'using System;',
				'namespace MyApp;',
			].join('\n');
			const sorted = sortUsingsInContent(content);
			assert.ok(sorted);
			const lines = sorted!.split('\n').slice(0, 3);
			assert.strictEqual(lines[0], 'using System;');
			assert.strictEqual(lines[1], 'using System.Linq;');
			assert.strictEqual(lines[2], 'using MyApp.Domain;');
		});

		test('deduplicates usings', () => {
			const content = [
				'using System;',
				'using System;',
				'namespace MyApp;',
			].join('\n');
			const sorted = sortUsingsInContent(content);
			assert.ok(sorted);
			assert.strictEqual((sorted!.match(/^using System;/gm) ?? []).length, 1);
		});

		test('returns undefined when already sorted', () => {
			const content = [
				'using System;',
				'using System.Linq;',
				'namespace MyApp;',
			].join('\n');
			assert.strictEqual(sortUsingsInContent(content), undefined);
		});

		test('does not rewrite using directives inside namespace body', () => {
			const content = [
				'using MyApp.Domain;',
				'using System;',
				'',
				'namespace MyApp',
				'{',
				'    using Nested;',
				'    public class Book { }',
				'}',
			].join('\n');

			const sorted = sortUsingsInContent(content);

			assert.ok(sorted);
			assert.ok(sorted!.includes('    using Nested;'));
			assert.ok(sorted!.includes('public class Book { }'));
		});
	});

	suite('isUsingOrderSorted', () => {
		test('treats System.* group before other namespaces as sorted (regression)', () => {
			// Reported bug: this is correctly sorted (System.* first, then alphabetical),
			// but the diagnostic used to flag it because it compared the whole list
			// alphabetically without accounting for the System.* group.
			const content = [
				'using System.Reflection;',
				'using Books.Application.Behaviors;',
				'using FluentValidation;',
				'using Microsoft.Extensions.DependencyInjection;',
				'using MitMediator;',
				'namespace MyApp;',
			].join('\n');

			const usingBlock = collectTopLevelUsingBlock(content);
			assert.ok(usingBlock);
			assert.strictEqual(isUsingOrderSorted(usingBlock!.directives), true);
		});

		test('detects usings that are actually unsorted', () => {
			const content = [
				'using System;',
				'using Microsoft.Extensions.DependencyInjection;',
				'using Books.Application.Behaviors;',
				'namespace MyApp;',
			].join('\n');

			const usingBlock = collectTopLevelUsingBlock(content);
			assert.ok(usingBlock);
			assert.strictEqual(isUsingOrderSorted(usingBlock!.directives), false);
		});

		test('same-sorted content matches sortUsingsInContent output (no changes needed)', () => {
			const content = [
				'using System.Reflection;',
				'using Books.Application.Behaviors;',
				'using FluentValidation;',
				'using Microsoft.Extensions.DependencyInjection;',
				'using MitMediator;',
				'namespace MyApp;',
			].join('\n');

			assert.strictEqual(sortUsingsInContent(content), undefined);
		});
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
