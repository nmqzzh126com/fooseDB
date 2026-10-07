import type {ReactNode} from 'react';
import clsx from 'clsx';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

type FeatureItem = {
  title: string;
  Svg: React.ComponentType<React.ComponentProps<'svg'>>;
  description: ReactNode;
};

const FeatureList: FeatureItem[] = [
  {
    title: "安装部署要求",
    Svg: require("@site/static/img/undraw_docusaurus_mountain.svg").default,
    description: (
      <>
        Node.js ≥ 22.22.1 <br />
        pnpm ≥ 11 <br />
        Redis ≥ 5
      </>
    ),
  },
  {
    title: "可同时创建多个接口",
    Svg: require("@site/static/img/undraw_docusaurus_tree.svg").default,
    description: <>接口数量不受限制.</>,
  },
  {
    title: "完全开源免费",
    Svg: require("@site/static/img/undraw_docusaurus_react.svg").default,
    description: (
      <>
        接口部分基于Fastify <br />
        管理后台基于vue3(https://pure-admin.cn/)
      </>
    ),
  },
];

function Feature({title, Svg, description}: FeatureItem) {
  return (
    <div className={clsx('col col--4')}>
      <div className="text--center">
        <Svg className={styles.featureSvg} role="img" />
      </div>
      <div className="text--center padding-horiz--md">
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}

export default function HomepageFeatures(): ReactNode {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
