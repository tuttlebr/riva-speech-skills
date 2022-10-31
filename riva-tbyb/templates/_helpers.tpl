{{/*
*/}}

{{/* vim: set filetype=mustache: */}}
{{/*
Create inference server name.
*/}}
{{- define "riva-server.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "riva-server.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
  Create inference server metrics service name and fullname derived from above and
  truncated appropriately.
*/}}
{{- define "riva-server-metrics.name" -}}
{{- $basename := include "riva-server.name" . -}}
{{- $basename_trimmed := $basename | trunc 55 | trimSuffix "-" -}}
{{- printf "%s-%s" $basename_trimmed "metrics" -}}
{{- end -}}

{{- define "riva-server-metrics.fullname" -}}
{{- $basename := include "riva-server.fullname" . -}}
{{- $basename_trimmed := $basename | trunc 55 | trimSuffix "-" -}}
{{- printf "%s-%s" $basename_trimmed "metrics" -}}
{{- end -}}

{{/*
  Create inference server metrics monitor name and fullname derived from
  above and truncated appropriately.
*/}}
{{- define "riva-server-metrics-monitor.name" -}}
{{- $basename := include "riva-server.name" . -}}
{{- $basename_trimmed := $basename | trunc 47 | trimSuffix "-" -}}
{{- printf "%s-%s" $basename_trimmed "metrics-monitor" -}}
{{- end -}}

{{- define "riva-server-metrics-monitor.fullname" -}}
{{- $basename := include "riva-server.fullname" . -}}
{{- $basename_trimmed := $basename | trunc 47 | trimSuffix "-" -}}
{{- printf "%s-%s" $basename_trimmed "metrics-monitor" -}}
{{- end -}}

{{/*
  Create ingressroute names derived from above and truncated appropriately
*/}}
{{- define "riva-server-ingressroute-http.name" -}}
{{- $basename := include "riva-server.name" . -}}
{{- $basename_trimmed := $basename | trunc 50 | trimSuffix "-" -}}
{{- printf "%s-%s" $basename_trimmed "ingress-http" -}}
{{- end -}}

{{- define "riva-server-ingressroute-grpc.name" -}}
{{- $basename := include "riva-server.name" . -}}
{{- $basename_trimmed := $basename | trunc 50 | trimSuffix "-" -}}
{{- printf "%s-%s" $basename_trimmed "ingress-grpc" -}}
{{- end -}}

{{- define "riva-server-ingressroute-riva.name" -}}
{{- $basename := include "riva-server.name" . -}}
{{- $basename_trimmed := $basename | trunc 50 | trimSuffix "-" -}}
{{- printf "%s-%s" $basename_trimmed "ingress-riva" -}}
{{- end -}}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "riva-server.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ngcPullSecret" }}
{{- with .Values.ngcCredentials }}
{{- printf "{\"auths\":{\"%s\":{\"username\":\"%s\",\"password\":\"%s\",\"email\":\"%s\",\"auth\":\"%s\"}}}" .registry .username .password .email (printf "%s:%s" .username .password | b64enc) | b64enc }}
{{- end -}}
{{- end -}}