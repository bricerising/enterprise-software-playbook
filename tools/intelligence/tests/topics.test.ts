import { describe, it, expect, beforeAll } from 'vitest';
import { loadTopics, classify, classifyIds, getLoadedTopics } from '../src/collector/topic-classifier.js';
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
    const topics = classifyIds('AWS Announces Bedrock Agents GA', 'Amazon Bedrock agents...');
    expect(topics).toContain('aws.bedrock');
  });

  it('classifies AI safety content', () => {
    const topics = classifyIds('Red Teaming LLMs', 'AI safety and alignment research...');
    expect(topics).toContain('ai.safety');
  });

  it('classifies CVE content', () => {
    const topics = classifyIds('CVE-2026-12345 Critical Vulnerability', 'exploit found in...');
    expect(topics).toContain('security.vulnerability');
  });

  it('requires context for short acronyms like EKS', () => {
    // EKS without AWS context should not match
    const noContext = classifyIds('EKS performance tips', 'general performance article');
    expect(noContext).not.toContain('aws.eks');

    // EKS with AWS context should match
    const withContext = classifyIds(
      'EKS performance tips',
      'AWS kubernetes cluster pod management',
    );
    expect(withContext).toContain('aws.eks');
  });

  it('requires context for RAG acronym', () => {
    // RAG without context should not match
    const noContext = classifyIds('RAG review', 'This rag is excellent');
    expect(noContext).not.toContain('ai.rag');

    // RAG with AI context should match
    const withContext = classifyIds(
      'Building RAG Applications',
      'retrieval augmented generation with vector embeddings',
    );
    expect(withContext).toContain('ai.rag');
  });

  it('returns at most 5 topics', () => {
    const topics = classifyIds(
      'AWS Lambda Kubernetes Docker Terraform OpenAI Bedrock',
      'serverless container function kubernetes cluster terraform openai gpt-4 bedrock sagemaker security vulnerability cve',
    );
    expect(topics.length).toBeLessThanOrEqual(5);
  });

  it('sorts by priority (highest first)', () => {
    const topics = classifyIds(
      'AWS releases new general features',
      'amazon web services ec2 instance compute',
    );
    // aws.ec2 (priority 30) should come after other higher-priority matches
    if (topics.includes('aws.general') && topics.includes('aws.ec2')) {
      expect(topics.indexOf('aws.ec2')).toBeLessThan(topics.indexOf('aws.general'));
    }
  });

  it('returns empty for unrelated content', () => {
    const topics = classifyIds('Local bakery opens new location', 'Fresh bread and pastries daily');
    expect(topics.length).toBe(0);
  });

  it('returns confidence scores with classify()', () => {
    const topics = classify('AWS Announces Bedrock Agents GA', 'Amazon Bedrock agents...');
    expect(topics.length).toBeGreaterThan(0);
    for (const t of topics) {
      expect(typeof t.id).toBe('string');
      expect(typeof t.confidence).toBe('number');
      expect(t.confidence).toBeGreaterThan(0);
      expect(t.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('multi-keyword matches have higher confidence', () => {
    // Single keyword match
    const single = classify('Bedrock article', null);
    // Multiple keyword matches
    const multi = classify('Amazon Bedrock agents with Claude', 'Amazon Bedrock serverless AI agents bedrock');
    if (single.length > 0 && multi.length > 0) {
      const singleBedrock = single.find(t => t.id === 'aws.bedrock');
      const multiBedrock = multi.find(t => t.id === 'aws.bedrock');
      if (singleBedrock && multiBedrock) {
        expect(multiBedrock.confidence).toBeGreaterThanOrEqual(singleBedrock.confidence);
      }
    }
  });
});
