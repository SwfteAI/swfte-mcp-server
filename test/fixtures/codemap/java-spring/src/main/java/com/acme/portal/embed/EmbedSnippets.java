package com.acme.portal.embed;

/** Chat embeds for the transactional e-mails and the static status page (not rendered by Thymeleaf). */
public final class EmbedSnippets {

    public static final String SUPPORT_IFRAME = """
            <iframe src="https://app.swfte.com/chat/ag_JvSup1"
                    title="Acme support" width="400" height="600"></iframe>
            """;

    public static final String STATUS_WIDGET = """
            <script src="https://unpkg.com/@swfte/chat-widget@1.4.0/dist/swfte-chat.umd.js"></script>
            <script>
              new SwfteChatWidget({ agentId: "ag_JvStat8", type: "bubble" }).mount();
            </script>
            """;

    private EmbedSnippets() {
    }

    public static String docsFrame() {
        return "<iframe src=\"https://app.swfte.com/chat/ag_JvDocs\" title=\"Docs\" width=\"100%\" height=\"560\"></iframe>";
    }

    public static String supportWidget(String theme) {
        return String.format(
                "<script>new SwfteChatWidget({ agentId: \"ag_JvSup1\", theme: \"%s\" }).mount();</script>", theme);
    }

    public static String iframeFor(String agentRef) {
        return String.format("<iframe src=\"https://app.swfte.com/chat/%s\" title=\"Assistant\"></iframe>", agentRef);
    }
}
