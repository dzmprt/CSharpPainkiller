using NamespaceScenarios.Before; // preserve the comment

namespace NamespaceScenarios.Consumers;
[Moved]
public class OnlyMoving
{
    public Moving Value { get; } = new Moving();
    public Moving.Inner<string> Nested { get; } = new Moving.Inner<string>();
}
