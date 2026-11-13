using NamespaceScenarios.Before;

namespace NamespaceScenarios.Consumers;
public class Mixed
{
    public Moving Value { get; } = new Moving();
    public Staying Other { get; } = new Staying();
    public int ExtensionOnly() => Other.MovedExtension();
}
