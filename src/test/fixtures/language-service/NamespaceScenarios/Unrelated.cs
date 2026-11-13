using NamespaceScenarios.Before;

namespace NamespaceScenarios.Consumers;
public class Unrelated
{
    public Staying Other { get; } = new Staying();
    public const string Example = "Moving NamespaceScenarios.Before";
    // Moving is deliberately not used here.
}
