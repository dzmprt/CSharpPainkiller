import { type FoundType } from '../../utils/typeSearch.js';

// ============================================================================
// ASP.NET template generators
// ============================================================================

/**
 * Normalises a controller name: strips a trailing "Controller" suffix (case-insensitive)
 * so it can be re-appended consistently. If the user entered "AuthorsController"
 * we produce class "AuthorsController" (not "AuthorsControllerController").
 */
export function normalizeControllerName(input: string): string {
	return input.replace(/Controller$/i, '');
}

// ─── Empty Controller ─────────────────────────────────────────────────────────

/**
 * Generates an empty ASP.NET Core MVC/ApiController file.
 *
 * @param baseName  - Name without "Controller" suffix (e.g. "Authors")
 * @param namespace - Target namespace
 */
export function generateEmptyController(baseName: string, namespace: string): string {
	const className = `${baseName}Controller`;
	return `using Microsoft.AspNetCore.Mvc;

namespace ${namespace};

[ApiController]
[Route("[controller]")]
public class ${className} : ControllerBase
{
}
`;
}

// ─── EF CRUD Controller ───────────────────────────────────────────────────────

/**
 * Generates an ASP.NET Core API controller with full CRUD operations
 * backed by Entity Framework Core.
 *
 * @param baseName     - Controller base name (e.g. "Authors")
 * @param entityType   - The entity class info found in the workspace
 * @param namespace    - Target namespace
 */
export function generateEfCrudController(
	baseName: string,
	entityType: FoundType,
	namespace: string
): string {
	const className = `${baseName}Controller`;
	const entity = entityType.name;
	const entityLower = entity.charAt(0).toLowerCase() + entity.slice(1);
	const entityNamespace = entityType.namespace;

	const usings = buildUsings(namespace, [
		'Microsoft.AspNetCore.Mvc',
		'Microsoft.EntityFrameworkCore',
		...(entityNamespace && entityNamespace !== namespace ? [entityNamespace] : []),
	]);

	return `${usings}
namespace ${namespace};

[ApiController]
[Route("[controller]")]
public class ${className} : ControllerBase
{
    private readonly DbContext _context;

    public ${className}(DbContext context)
    {
        _context = context;
    }

    // GET: api/${baseName}
    [HttpGet]
    public async Task<ActionResult<IEnumerable<${entity}>>> GetAll()
    {
        return await _context.Set<${entity}>().ToListAsync();
    }

    // GET: api/${baseName}/5
    [HttpGet("{id}")]
    public async Task<ActionResult<${entity}>> GetById(int id)
    {
        var ${entityLower} = await _context.Set<${entity}>().FindAsync(id);
        if (${entityLower} == null)
        {
            return NotFound();
        }
        return ${entityLower};
    }

    // POST: api/${baseName}
    [HttpPost]
    public async Task<ActionResult<${entity}>> Create(${entity} ${entityLower})
    {
        _context.Set<${entity}>().Add(${entityLower});
        await _context.SaveChangesAsync();
        return CreatedAtAction(nameof(GetById), new { id = ${entityLower}.Id }, ${entityLower});
    }

    // PUT: api/${baseName}/5
    [HttpPut("{id}")]
    public async Task<IActionResult> Update(int id, ${entity} ${entityLower})
    {
        if (id != ${entityLower}.Id)
        {
            return BadRequest();
        }

        _context.Entry(${entityLower}).State = EntityState.Modified;

        try
        {
            await _context.SaveChangesAsync();
        }
        catch (DbUpdateConcurrencyException)
        {
            if (!await _context.Set<${entity}>().AnyAsync(e => e.Id == id))
            {
                return NotFound();
            }
            throw;
        }

        return NoContent();
    }

    // DELETE: api/${baseName}/5
    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(int id)
    {
        var ${entityLower} = await _context.Set<${entity}>().FindAsync(id);
        if (${entityLower} == null)
        {
            return NotFound();
        }

        _context.Set<${entity}>().Remove(${entityLower});
        await _context.SaveChangesAsync();

        return NoContent();
    }
}
`;
}

// ─── Empty Minimal API ────────────────────────────────────────────────────────

/**
 * Generates an empty Minimal API static extension class.
 *
 * @param baseName  - Resource name (e.g. "Authors")
 * @param namespace - Target namespace
 */
export function generateEmptyMinimalApi(baseName: string, namespace: string): string {
	const className = `${baseName}Api`;
	const methodName = `Use${baseName}Api`;
	const tag = baseName;

	return `namespace ${namespace};

internal static class ${className}
{
    private const string Tag = "${tag}";

    public static WebApplication ${methodName}(this WebApplication app)
    {
        return app;
    }
}
`;
}

// ─── EF CRUD Minimal API ──────────────────────────────────────────────────────

/**
 * Generates a Minimal API static extension class with full CRUD operations
 * backed by Entity Framework Core.
 *
 * @param baseName   - Resource name (e.g. "Authors")
 * @param entityType - The entity class info found in the workspace
 * @param namespace  - Target namespace
 */
export function generateEfCrudMinimalApi(
	baseName: string,
	entityType: FoundType,
	namespace: string
): string {
	const className = `${baseName}Api`;
	const methodName = `Use${baseName}Api`;
	const entity = entityType.name;
	const entityLower = entity.charAt(0).toLowerCase() + entity.slice(1);
	const entityNamespace = entityType.namespace;
	const tag = baseName;
	// URL path segment: lowercase of baseName
	const route = baseName.charAt(0).toLowerCase() + baseName.slice(1);

	const usings = buildUsings(namespace, [
		'Microsoft.EntityFrameworkCore',
		...(entityNamespace && entityNamespace !== namespace ? [entityNamespace] : []),
	]);

	return `${usings}
namespace ${namespace};

internal static class ${className}
{
    private const string Tag = "${tag}";

    public static WebApplication ${methodName}(this WebApplication app)
    {
        app.MapGet($"${route}", GetAllAsync)
            .WithTags(Tag)
            .WithName("Get all ${entity}.")
            .WithGroupName("v1")
            .Produces<List<${entity}>>();

        app.MapGet($"${route}/{{id:int}}", GetByIdAsync)
            .WithTags(Tag)
            .WithName("Get ${entity} by id.")
            .WithGroupName("v1")
            .Produces<${entity}>()
            .Produces(StatusCodes.Status404NotFound);

        app.MapPost($"${route}", CreateAsync)
            .WithTags(Tag)
            .WithName("Create ${entity}.")
            .WithGroupName("v1")
            .Produces<${entity}>(StatusCodes.Status201Created);

        app.MapPut($"${route}/{{id:int}}", UpdateAsync)
            .WithTags(Tag)
            .WithName("Update ${entity}.")
            .WithGroupName("v1")
            .Produces(StatusCodes.Status204NoContent)
            .Produces(StatusCodes.Status400BadRequest)
            .Produces(StatusCodes.Status404NotFound);

        app.MapDelete($"${route}/{{id:int}}", DeleteAsync)
            .WithTags(Tag)
            .WithName("Delete ${entity}.")
            .WithGroupName("v1")
            .Produces(StatusCodes.Status204NoContent)
            .Produces(StatusCodes.Status404NotFound);

        return app;
    }

    private static async Task<IResult> GetAllAsync(DbContext db)
    {
        var items = await db.Set<${entity}>().ToListAsync();
        return Results.Ok(items);
    }

    private static async Task<IResult> GetByIdAsync(int id, DbContext db)
    {
        var ${entityLower} = await db.Set<${entity}>().FindAsync(id);
        return ${entityLower} is null
            ? Results.NotFound()
            : Results.Ok(${entityLower});
    }

    private static async Task<IResult> CreateAsync(${entity} ${entityLower}, DbContext db)
    {
        db.Set<${entity}>().Add(${entityLower});
        await db.SaveChangesAsync();
        return Results.Created($"/${route}/{${entityLower}.Id}", ${entityLower});
    }

    private static async Task<IResult> UpdateAsync(int id, ${entity} ${entityLower}, DbContext db)
    {
        if (id != ${entityLower}.Id)
        {
            return Results.BadRequest();
        }

        db.Entry(${entityLower}).State = EntityState.Modified;

        try
        {
            await db.SaveChangesAsync();
        }
        catch (DbUpdateConcurrencyException)
        {
            if (!await db.Set<${entity}>().AnyAsync(e => e.Id == id))
            {
                return Results.NotFound();
            }
            throw;
        }

        return Results.NoContent();
    }

    private static async Task<IResult> DeleteAsync(int id, DbContext db)
    {
        var ${entityLower} = await db.Set<${entity}>().FindAsync(id);
        if (${entityLower} is null)
        {
            return Results.NotFound();
        }

        db.Set<${entity}>().Remove(${entityLower});
        await db.SaveChangesAsync();
        return Results.NoContent();
    }
}
`;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Builds a sorted using-directive block.
 * Namespaces that match or start with the target namespace are omitted.
 */
function buildUsings(targetNamespace: string, namespaces: string[]): string {
	const unique = [...new Set(namespaces)].filter(ns => ns !== targetNamespace);
	if (unique.length === 0) {
		return '';
	}
	return unique.map(ns => `using ${ns};`).join('\n') + '\n';
}
