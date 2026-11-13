using M = NamespaceScenarios.Before.Moving;
using N = NamespaceScenarios.Before;

namespace NamespaceScenarios.Consumers
{
    public class AliasConsumer
    {
        public M Value { get; } = new M();
        public N.Moving Another { get; } = new N.Moving();
        public N.Staying Other { get; } = new N.Staying();
    }
}

namespace NamespaceScenarios.Qualified
{
    public class QualifiedConsumer
    {
        public global::NamespaceScenarios.Before.Moving Value { get; } = new global::NamespaceScenarios.Before.Moving();
    }
}

namespace NamespaceScenarios.Static
{
    using static NamespaceScenarios.Before.Moving;
    public class StaticConsumer
    {
        public int Value() => Number();
    }
}

namespace NamespaceScenarios.Extension
{
    using NamespaceScenarios.Before;
    public class ExtensionConsumer
    {
        public int Value() => new Staying().MovedExtension();
    }
}

namespace NamespaceScenarios.Relative
{
    public class RelativeConsumer
    {
        public Before.Moving Value { get; } = new Before.Moving();
    }
}

namespace NamespaceScenarios.StaticExtension
{
    public class StaticExtensionConsumer
    {
        public int Value() => Before.MovingExtensions.MovedExtension(new Before.Staying());
    }
}
