# Build.
#
# CGO stays off: modernc.org/sqlite is pure Go, so the whole server links
# statically and the runtime image needs nothing but the binary and CA roots.
FROM golang:1.26-alpine AS build

WORKDIR /src

# Dependencies first, so a code-only change does not re-download the module
# cache on every deploy.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
# schema.sql is embedded via go:embed, so it travels inside the binary.
RUN CGO_ENABLED=0 GOOS=linux go build \
      -trimpath \
      -ldflags="-s -w" \
      -o /out/rtld ./cmd/rtld

# Run.
#
# distroless/static carries CA certificates — needed, because the server calls
# RTL over HTTPS — and nothing else: no shell, no package manager, no libc.
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/rtld /rtld

# The database lives on a mounted volume so it survives redeploys. deploy.sh
# runs the container as the invoking user, which is why nothing is chowned here.
VOLUME ["/data"]

EXPOSE 8080

ENTRYPOINT ["/rtld"]
CMD ["-addr", ":8080", "-db", "/data/rtld.db"]
