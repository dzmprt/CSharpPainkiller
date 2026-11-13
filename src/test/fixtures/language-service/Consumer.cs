namespace LanguageService;

public class Consumer
{
    public Book Create() => new Book();
    public const string Example = "Book";
    public RenameTarget Target() => new RenameTarget();
}

public class ReadOnlyBook
{
    public int Id { get; }
    public ReadOnlyBook(int id) { Id = id; }
}
