import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Driver-only capture from freshly compiled, real backend provider/test classes. No HTTP. */
public class BackendFixtureCapture {
    private static final String PKG = "com.swfte.scp.agentservice.catalog.contract.";
    private static final List<String> SOURCES = List.of(
            "src/main/java/com/swfte/scp/agentservice/catalog/CatalogKind.java",
            "src/main/java/com/swfte/scp/agentservice/catalog/model/CatalogContract.java",
            "src/main/java/com/swfte/scp/agentservice/catalog/contract/SotCatalogContractProvider.java",
            "src/main/java/com/swfte/scp/agentservice/catalog/contract/ContractSnippets.java",
            "src/main/java/com/swfte/scp/agentservice/catalog/contract/ContractHash.java",
            "src/main/java/com/swfte/scp/agentservice/catalog/contract/WorkflowSchemaDeriver.java",
            "src/main/java/com/swfte/scp/agentservice/catalog/contract/WorkflowSchemaService.java",
            "src/test/java/com/swfte/scp/agentservice/catalog/contract/SotContractProviderTest.java",
            "src/test/java/com/swfte/scp/agentservice/catalog/contract/SotSchemaDerivationTest.java",
            "src/test/java/com/swfte/scp/agentservice/catalog/contract/SotDerivedFixtureGoldenTest.java");

    private static String sha(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static Object call(Object target, String name, Class<?>[] types, Object... args) throws Exception {
        Method method = target.getClass().getDeclaredMethod(name, types);
        method.setAccessible(true);
        return method.invoke(target, args);
    }

    private static Object field(Object target, String name) throws Exception {
        Field field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        return field.get(target);
    }

    @SuppressWarnings({"rawtypes", "unchecked"})
    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException("backend-root and fixture-output are required");
        Path backend = Path.of(args[0]).toRealPath();
        Path output = Path.of(args[1]).toAbsolutePath().normalize();
        if (!output.equals(Path.of("/private/tmp/swfte-p5-resume-20261001/mcp/test/fixtures/phase5-contracts"))) {
            throw new IllegalArgumentException("Output must be the claimed task fixture directory");
        }
        if (!backend.equals(Path.of("/private/tmp/swfte-p5-resume-20261001/as-integration"))) {
            throw new IllegalArgumentException("Use the fresh isolated integration backend");
        }
        Files.createDirectories(output);
        Class<?> suite = Class.forName(PKG + "SotContractProviderTest");
        Constructor<?> constructor = suite.getDeclaredConstructor();
        constructor.setAccessible(true);
        Object tests = constructor.newInstance();
        call(tests, "setUp", new Class<?>[0]);
        List<?> contracts = (List<?>) call(tests, "everyKind", new Class<?>[0]);
        List<Object[]> cases = new ArrayList<>();
        for (Object contract : contracts) cases.add(new Object[]{contract, "provider-everyKind"});
        Object provider = field(tests, "provider");
        Class kindClass = Class.forName("com.swfte.scp.agentservice.catalog.CatalogKind");
        Class<?> entryClass = Class.forName("com.swfte.scp.agentservice.catalog.CatalogEntry");
        Method pub = suite.getDeclaredMethod("pub", kindClass, String.class, Map.class);
        pub.setAccessible(true);
        Object publicAgent = pub.invoke(null, Enum.valueOf(kindClass, "AGENT"), "ag_pub", Map.of());
        cases.add(new Object[]{provider.getClass().getMethod("contractFor", entryClass).invoke(provider, publicAgent), "public-agent"});
        Object imageModel = pub.invoke(null, Enum.valueOf(kindClass, "MODEL"), "sdxl", Map.of("modelType", "image-generation"));
        cases.add(new Object[]{provider.getClass().getMethod("contractFor", entryClass).invoke(provider, imageModel), "image-model"});
        Method twoInput = Class.forName(PKG + "SotSchemaDerivationTest").getDeclaredMethod("twoInputWorkflow");
        twoInput.setAccessible(true);
        Object workflow = twoInput.invoke(null);
        Object schemas = field(provider, "workflowSchemas");
        Object loaded = schemas.getClass().getMethod("load", workflow.getClass()).invoke(schemas, workflow);
        Object pinned = provider.getClass().getMethod("workflowContract", loaded.getClass(), boolean.class).invoke(provider, loaded, true);
        cases.add(new Object[]{pinned, "pinned-workflow"});

        Object mapper = Class.forName("com.swfte.scp.agentservice.catalog.CatalogJson").getMethod("mapper").invoke(null);
        Object writer = mapper.getClass().getMethod("writerWithDefaultPrettyPrinter").invoke(mapper);
        Method serialize = writer.getClass().getMethod("writeValueAsString", Object.class);
        List<Map<String, Object>> rows = new ArrayList<>();
        byte[] golden = Files.readAllBytes(backend.resolve("src/test/resources/catalog/g3/two-input-workflow.contract.json"));
        for (Object[] item : cases) {
            Object contract = item[0];
            String variant = String.valueOf(item[1]);
            String ref = String.valueOf(contract.getClass().getMethod("catalogRef").invoke(contract));
            String name = ref.replaceAll("[^A-Za-z0-9_-]", "_") + (variant.equals("provider-everyKind") ? "" : "_" + variant) + ".contract.json";
            byte[] bytes = (((String) serialize.invoke(writer, contract)) + "\n").getBytes(StandardCharsets.UTF_8);
            if (ref.equals("workflow:wf_1") && variant.equals("provider-everyKind") && !java.util.Arrays.equals(bytes, golden)) {
                throw new IllegalStateException("Actual provider workflow must match the committed derived golden byte for byte");
            }
            Files.write(output.resolve(name), bytes);
            String digest = sha(bytes);
            Files.writeString(output.resolve(name + ".sha256"), digest + "  " + name + "\n", StandardCharsets.UTF_8);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("file", name);
            row.put("catalogRef", ref);
            row.put("kind", ref.substring(0, ref.indexOf(':')));
            row.put("variant", variant);
            row.put("sha256", digest);
            row.put("origin", "actual backend CatalogContract record; SotContractProviderTest fixture factory and real SotCatalogContractProvider");
            rows.add(row);
        }
        Map<String, String> sources = new LinkedHashMap<>();
        for (String source : SOURCES) sources.put(source, sha(Files.readAllBytes(backend.resolve(source))));
        Process git = new ProcessBuilder("git", "rev-parse", "HEAD").directory(backend.toFile()).start();
        String head = new String(git.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
        if (git.waitFor() != 0 || !head.matches("[0-9a-f]{40}")) throw new IllegalStateException("Backend commit unavailable");
        Map<String, Object> provenance = new LinkedHashMap<>();
        provenance.put("format", 1);
        provenance.put("mode", "driver-captured-real-backend-records");
        provenance.put("backendCommit", head);
        provenance.put("sourceSha256", sources);
        provenance.put("derivedGoldenSha256", sha(golden));
        provenance.put("captureSourceSha256", sha(Files.readAllBytes(output.resolve("BackendFixtureCapture.java"))));
        provenance.put("cases", rows);
        Files.writeString(output.resolve("provenance.json"), serialize.invoke(writer, provenance) + "\n", StandardCharsets.UTF_8);
        System.out.println("P5_BACKEND_CONTRACT_FIXTURES_CAPTURED=" + rows.size());
    }
}
