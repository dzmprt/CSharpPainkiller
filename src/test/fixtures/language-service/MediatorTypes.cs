namespace MediatR
{
    public interface IRequest<T> {}
    public interface IRequestHandler<TRequest, TResponse> {}
}

namespace LanguageService
{
    public record class FindBookQuery : IRequest<string>;
    public record class OtherQuery : global::MediatR.IRequest<int>;
    public class ConstraintOnly<T> where T : IRequestHandler<FindBookQuery, string> {}
    public class ArbitraryHandler : IRequestHandler<FindBookQuery, string> {}
}
