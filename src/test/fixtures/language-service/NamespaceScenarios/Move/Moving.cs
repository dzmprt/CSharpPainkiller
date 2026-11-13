namespace NamespaceScenarios.Before;

public class Moving
{
    public Staying LeftBehind { get; } = new Staying();
    public static int Number() => 1;
    public class Inner<T> { }
}

public class MovedAttribute : global::System.Attribute { }

public static class MovingExtensions
{
    public static int MovedExtension(this Staying value) => 1;
}
