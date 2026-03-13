import { describe, it, expect, beforeAll } from 'vitest';
import { loadTopics, classify, getLoadedTopics } from '../src/collector/topic-classifier.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const topicsPath = join(__dirname, '..', 'config', 'topics.yaml');

beforeAll(() => {
  loadTopics(topicsPath);
});

describe('loadTopics', () => {
  it('loads topics from YAML', () => {
    const topics = getLoadedTopics();
    expect(topics.length).toBeGreaterThan(50);
  });

  it('each topic has required fields', () => {
    for (const t of getLoadedTopics()) {
      expect(t.id).toBeTruthy();
      expect(t.label).toBeTruthy();
      expect(t.priority).toBeGreaterThan(0);
    }
  });
});

describe('classify', () => {
  it('classifies AWS Bedrock content', () => {
    const topics = classify('AWS Announces Bedrock Agents GA', 'Amazon Bedrock agents...');
    expect(topics).toContain('aws.bedrock');
  });

  it('classifies AI safety content', () => {
    const topics = classify('Red Teaming LLMs', 'AI safety and alignment research...');
    expect(topics).toContain('ai.safety');
  });

  it('classifies CVE content', () => {
    const topics = classify('CVE-2026-12345 Critical Vulnerability', 'exploit found in...');
    expect(topics).toContain('security.vulnerability');
  });

  it('requires context for short acronyms like EKS', () => {
    // EKS without AWS context should not match
    const noContext = classify('EKS performance tips', 'general performance article');
    expect(noContext).not.toContain('aws.eks');

    // EKS with AWS context should match
    const withContext = classify(
      'EKS performance tips',
      'AWS kubernetes cluster pod management',
    );
    expect(withContext).toContain('aws.eks');
  });

  it('requires context for RAG acronym', () => {
    // RAG without context should not match
    const noContext = classify('RAG review', 'This rag is excellent');
    expect(noContext).not.toContain('ai.rag');

    // RAG with AI context should match
    const withContext = classify(
      'Building RAG Applications',
      'retrieval augmented generation with vector embeddings',
    );
    expect(withContext).toContain('ai.rag');
  });

  it('returns at most 5 topics', () => {
    const topics = classify(
      'AWS Lambda Kubernetes Docker Terraform OpenAI Bedrock',
      'serverless container function kubernetes cluster terraform openai gpt-4 bedrock sagemaker security vulnerability cve',
    );
    expect(topics.length).toBeLessThanOrEqual(5);
  });

  it('sorts by priority (highest first)', () => {
    const topics = classify(
      'AWS releases new general features',
      'amazon web services ec2 instance compute',
    );
    // aws.ec2 (priority 30) should come after other higher-priority matches
    if (topics.includes('aws.general') && topics.includes('aws.ec2')) {
      expect(topics.indexOf('aws.ec2')).toBeLessThan(topics.indexOf('aws.general'));
    }
  });

  it('returns empty for unrelated content', () => {
    const topics = classify('Local bakery opens new location', 'Fresh bread and pastries daily');
    expect(topics.length).toBe(0);
  });
});
