namespace LanguageService;

// public class FakeBook {}
public class Book
{
    public Book() {}
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string Example => """public class StringBook { }""";

    public class Nested
    {
        public string NestedName { get; set; } = "";
    }
}

public record class BookDto(int Id, string Name);
