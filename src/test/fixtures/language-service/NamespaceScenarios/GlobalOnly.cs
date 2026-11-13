namespace NamespaceScenarios.Consumers;
public class GlobalOnly
{
    public Moving Value { get; } = new Moving();
    public GlobalM AliasValue { get; } = new GlobalM();
    public GlobalN.Moving NamespaceAliasValue { get; } = new GlobalN.Moving();
}
