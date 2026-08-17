/*
 * SPDX-License-Identifier: EUPL-1.2
 *
 * Copyright (c) 2026 Till Gartner
 *
 * Part of Assistants.
 *
 * Licensed under the European Union Public Licence, version 1.2 - see
 * https://eupl.eu/ and the LICENSE file at the root of this repository.
 * Distributed on an "AS IS" basis, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.
 */

package com.grtnr.assistants.server.bookkeeping;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.stereotype.Component;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.googlecode.jsonrpc4j.JsonRpcParam;
import com.mgmtp.a12.dataservices.rpc.RemoteOperation;

/**
 * The client's way of asking for something only the Runtime can fetch (ADR-0023).
 *
 * <p>The Runtime is <b>the door outward</b>: every External System is reached through a Connector
 * there, and every foreign credential lives there. This class does not know what Firefly is, holds no
 * credential that could reach it, and stores nothing. It authenticates the User, checks the Operation
 * against an allowlist, and forwards.
 *
 * <p><b>What it is not.</b> Not a proxy: it takes an Operation key and arguments, never a path or a
 * method, so there is no request a caller can compose that this class would pass through unread. And
 * not the safety boundary — the Runtime refuses anything mutating, in code, whatever the allowlist
 * here says. This is the outer of two gates, and the weaker of them on purpose.
 *
 * <p><b>Why {@code @RemoteOperation}.</b> It lands on {@code /api/v2/rpc}, the endpoint the client
 * already speaks: the tiles reach it through the same {@code ServerConnector} as every other query,
 * with the same authentication and batching, and no second surface to secure. {@code isMutation =
 * false} is honest and buys read-replica routing where one exists. The method must literally be named
 * {@code rpc}, and {@code EXTERNAL_OPERATIONS} must appear in
 * {@code mgmtp.a12.dataservices.jsonRpc.allowedOperations}.
 *
 * <p>{@code @PreAuthorize} is not decoration: A12 walks every mapped endpoint at startup and refuses
 * to boot with one that declares no authorization policy. Without it this application does not start.
 */
@Component
@EnableConfigurationProperties(RuntimeProperties.class)
@RemoteOperation(name = "EXTERNAL_CALL", group = "EXTERNAL_OPERATIONS", isMutation = false)
@PreAuthorize("isAuthenticated()")
public class ExternalCallOperation {

    private static final Logger LOG = LoggerFactory.getLogger(ExternalCallOperation.class);

    private final RuntimeProperties properties;
    private final ObjectMapper mapper = new ObjectMapper();
    private final HttpClient http;

    public ExternalCallOperation(RuntimeProperties properties) {
        this.properties = properties;
        this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    }

    public Map<String, Object> rpc(
            @JsonRpcParam("operation") String operation,
            @JsonRpcParam("args") Map<String, Object> args) {

        if (operation == null || !properties.getAllowedOperations().contains(operation)) {
            // Deliberately the same answer for "no such Operation" and "not offered": a browser
            // probing this route learns nothing about the catalogue behind it.
            LOG.warn("refused an external call to an operation that is not offered: {}", operation);
            return Map.of("ok", false, "reason", "not-allowed");
        }

        try {
            String body = mapper.writeValueAsString(Map.of("args", args == null ? Map.of() : args));
            HttpRequest request = HttpRequest.newBuilder(
                            URI.create(properties.getUrl() + "/operations/" + operation))
                    .timeout(Duration.ofMillis(properties.getTimeoutMillis()))
                    .header("Content-Type", "application/json")
                    .header("X-Runtime-Secret", properties.getSharedSecret())
                    .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                    .build();

            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
            @SuppressWarnings("unchecked")
            Map<String, Object> answer = mapper.readValue(response.body(), Map.class);
            return answer;
        } catch (IOException | InterruptedException error) {
            if (error instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            // The door outward is shut -- the Runtime is down, restarting, or too slow. A fact about
            // the world, and distinguishable in the log from a refusal, which is a fact about the
            // request. The Tile renders the same error line either way.
            LOG.warn("the door outward did not answer for {}: {}", operation, error.toString());
            return Map.of("ok", false, "reason", "runtime-unreachable");
        }
    }
}
